// CLI probe for the SMTP setup behind verification mail:
//   bun run check:mail                  connect, negotiate TLS, authenticate, check DNS auth
//   bun run check:mail you@example.com  also deliver a real test message
// Step 2 goes through the app's own sendMail(), so a green run means sign-up mail will send too.
import { resolveTxt } from "node:dns/promises";
import { describeMailError, escapeHtml, htmlDocument, mailEnabled, mailSettings, sendMail, verifyMailTransport } from "./mail";

const USAGE = `usage: bun run check:mail [recipient] [--dkim-selector <name[,name]>]
       bun run check:mail --to <recipient>

  (no recipient)   connect + TLS + AUTH, plus the sender domain's SPF/DMARC/DKIM records
  <recipient>      additionally send one test message through sendMail()
  --dkim-selector  extra selector(s) to look up when the mail console uses an unusual name

Reads SMTP_* (and SMTP_DKIM_SELECTOR) from the environment (Bun loads .env). Exit code 0 means
the whole path works.
`;

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const splitSelectors = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

let to: string | undefined;
const envRaw = process.env.SMTP_DKIM_SELECTOR;
const envSelectors = splitSelectors(envRaw);
const flagSelectors: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--to") to = argv[++i]?.trim();
  else if (arg === "--dkim-selector") flagSelectors.push(...splitSelectors(argv[++i]));
  else if (!arg.startsWith("-")) to = arg.trim();
}
// Where the selector came from matters: an env var that never reached this process looks exactly
// like one that is set but wrong, so the report names the source of whichever selector it used.
const given = [
  ...flagSelectors.map((sel) => ({ sel, from: "--dkim-selector" })),
  ...envSelectors.map((sel) => ({ sel, from: "SMTP_DKIM_SELECTOR" })),
];
const selectorWarning =
  envRaw !== undefined && envSelectors.length === 0
    ? `SMTP_DKIM_SELECTOR is set to ${JSON.stringify(envRaw)} but parses to no selector; ignoring it`
    : null;

/** The SMTP reply says what to fix; the nodemailer stack never does. */
function hintFor(e: unknown): string | null {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const text = `${err?.code ?? ""} ${err?.responseCode ?? ""} ${err?.message ?? ""}`;
  if (/535|EAUTH|Invalid login/i.test(text))
    return "auth rejected: enterprise hosts often need an app-specific password (客户端专用密码), with the full address as SMTP_USER";
  if (/550|553|EENVELOPE|sender rejected/i.test(text))
    return "sender rejected: SMTP_FROM must be that mailbox, or an address the provider authorised";
  if (/ETIMEDOUT|ECONNECTION|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(text))
    return "cannot reach the server: many hosts block port 25 outbound; use 465 (implicit TLS) or 587 (STARTTLS)";
  if (/EDNS|ENOTFOUND|EAI_AGAIN/i.test(text)) return "DNS lookup failed: check SMTP_HOST";
  if (/self.signed|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/i.test(text))
    return "certificate rejected: for a self-signed relay set SMTP_ALLOW_SELF_SIGNED=true";
  return null;
}

function fail(stage: string, e: unknown): number {
  const err = describeMailError(e);
  console.error(`  FAILED (${stage}): ${err.message}`);
  const hint = hintFor(err);
  if (hint) console.error(`  hint: ${hint}`);
  return 1;
}

// ------------------------------------------------------------- sender authentication
// SPF/DMARC/DKIM are what decide spam-foldering far more than the wording of the message, and
// they live in DNS rather than in this app, so the probe reports them instead of guessing.

const DNS_TIMEOUT = "dns timeout";
const DNS_TIMEOUT_MS = 4000;
/** Common selectors; 腾讯企业邮 lets you pick the selector, so the list is a best effort. */
const DKIM_SELECTORS = ["dkim", "default", "s1", "s2", "selector1", "selector2", "tencent", "exmail", "mail", "google"];

/** null means "the lookup itself failed", [] means "the record does not exist". */
async function txtRecords(name: string): Promise<string[] | null> {
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(DNS_TIMEOUT)), DNS_TIMEOUT_MS);
    t.unref?.();
  });
  try {
    const rows = await Promise.race([resolveTxt(name), timeout]);
    return rows.map((parts) => parts.join(""));
  } catch (e) {
    return (e as Error)?.message === DNS_TIMEOUT ? null : [];
  }
}

function clip(s: string, max = 76): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

async function authReport(from: string, given: { sel: string; from: string }[]): Promise<string[]> {
  const domain = /@([^>\s,;]+)/.exec(from)?.[1]?.toLowerCase();
  if (!domain) return ["auth    skipped: sender has no domain to check"];

  // An explicit selector is authoritative; the built-in list is only a guess, and a key sitting
  // under a guessed name proves nothing about which selector the provider actually signs with
  // (企业邮 hands out random ones like yfrh2602, so `default` can exist and still never verify).
  const toName = (sel: string) => (sel.includes("._domainkey") ? sel : `${sel}._domainkey.${domain}`);
  const all = given.length
    ? given.map(({ sel, from: src }) => ({ name: toName(sel), source: src }))
    : DKIM_SELECTORS.map((sel) => ({ name: toName(sel), source: null as string | null }));
  const seen = new Set<string>();
  const candidates = all.filter((c) => !seen.has(c.name) && seen.add(c.name));

  const [root, dmarc, ...keys] = await Promise.all([
    txtRecords(domain),
    txtRecords(`_dmarc.${domain}`),
    ...candidates.map((c) => txtRecords(c.name)),
  ]);
  if (root === null && dmarc === null) return [`auth    ${domain}: DNS lookups failed, cannot verify SPF/DMARC/DKIM`];

  const spf = (root ?? []).find((t) => /^v=spf1\b/i.test(t));
  const policy = (dmarc ?? []).find((t) => /^v=DMARC1\b/i.test(t));
  const hit = candidates[keys.findIndex((rows) => (rows ?? []).some((t) => /^v=DKIM1|\bp=/i.test(t)))];
  const origin = hit?.source ? `from ${hit.source}` : "guessed selector";
  const dkimLine = hit
    ? `ok       ${hit.name}  (${origin})`
    : given.length
      ? `MISSING  no TXT at ${candidates.map((c) => c.name).join(", ")}`
      : `MISSING  no TXT under any of ${candidates.length} guessed selectors`;

  const lines = [
    `auth    ${domain}`,
    `        SPF    ${spf ? `ok       ${clip(spf)}` : "MISSING  no v=spf1 TXT on the domain"}`,
    `        DMARC  ${policy ? `ok       ${clip(policy)}` : "MISSING  no _dmarc TXT on the domain"}`,
    `        DKIM   ${dkimLine}`,
  ];
  if (hit && !hit.source)
    lines.push(
      "        note: a key under a guessed name does not prove your provider signs with it. If a sent",
      "              message still fails dkim (\"key not found in DNS\"), read `s=` from its",
      "              DKIM-Signature header and pass --dkim-selector <selector>.",
    );
  if (!hit)
    lines.push(
      "        note: the console switch only generates a key; the TXT still has to be published.",
      "        note: the selector is often random (企业邮 hands out names like yfrh2602), so guessing",
      "              is unreliable. Read the record name in the admin console, or the `s=` tag of a",
      "              received message's DKIM-Signature, then pass --dkim-selector <selector>.",
      "        note: without DKIM, SPF alone still spam-folders a low-volume sender.",
    );
  if (!spf || !policy)
    lines.push("        note: missing SPF or DMARC means most large providers will treat this sender as suspect.");
  return lines;
}

// ------------------------------------------------------------------------- checks

if (!mailEnabled()) {
  console.error("SMTP is off: SMTP_HOST is unset, so nothing is mailed and new sign-ups are not asked to verify.");
  console.error("Set SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS/SMTP_FROM (see .env.example), then re-run.");
  process.exitCode = 1;
} else {
  const s = mailSettings();
  const mode = s.secure ? "implicit TLS" : "STARTTLS, if the server offers it";
  console.log(`target  ${s.host}:${s.port} (${mode}, ${s.user ? `auth as ${s.user}` : "no auth"})`);
  console.log(`sender  ${s.from}`);
  if (selectorWarning) console.log(`warn    ${selectorWarning}`);
  for (const line of await authReport(s.from, given)) console.log(line);
  console.log("");

  console.log("[1/2] connect + TLS + AUTH ...");
  let connected = true;
  try {
    await verifyMailTransport();
    console.log("  ok");
  } catch (e) {
    connected = false;
    process.exitCode = fail("TLS/auth", e);
  }

  // nothing to send over a connection that never came up
  if (connected) {
    if (!to) {
      console.log("\nNo recipient given, so nothing was sent. Pass an address to deliver a test message.");
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      console.error(`\n"${to}" does not look like an email address.`);
      process.exitCode = 2;
    } else {
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const facts = [`服务器  ${s.host}:${s.port}（${mode}）`, `发件人  ${s.from}`, `时间    ${stamp}`];
      const text = [
        "这是一封来自 bunrss 的发信检查邮件。",
        "",
        "收到它说明 SMTP 已经能正常投递：连接、TLS 和认证都通过了。",
        "",
        ...facts,
        "",
        "如果它进了垃圾箱，先看命令输出的 auth 一节：缺 DKIM 是最常见的原因。",
      ].join("\n");
      const html = htmlDocument(
        "zh-CN",
        `<p>这是一封来自 <strong>bunrss</strong> 的发信检查邮件。</p>` +
          `<p>收到它说明 SMTP 已经能正常投递：连接、TLS 和认证都通过了。</p>` +
          `<p style="margin:16px 0;padding:12px 14px;background:#f7f7f5;border-radius:8px;font-size:13px;line-height:1.8;color:#444">${facts
            .map(escapeHtml)
            .join("<br>")}</p>` +
          `<p style="color:#666;font-size:13px">如果它进了垃圾箱，先看命令输出的 auth 一节：缺 DKIM 是最常见的原因。</p>`,
      );
      console.log(`[2/2] send to ${to} ...`);
      try {
        await sendMail(to, `bunrss 发信检查 · ${stamp}`, text, html);
        console.log("  ok");
        console.log(`\nDone: ${s.host} accepted a message from ${s.from} for ${to}.`);
        console.log("If it never arrives: check spam, and that the provider authorises that sender address.");
      } catch (e) {
        process.exitCode = fail("send", e);
      }
    }
  }
}

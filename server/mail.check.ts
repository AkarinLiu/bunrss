// CLI probe for the SMTP setup behind verification mail:
//   bun run check:mail                  connect, negotiate TLS, authenticate
//   bun run check:mail you@example.com  also deliver a real test message
// Step 2 goes through the app's own sendMail(), so a green run means sign-up mail will send too.
import { describeMailError, mailEnabled, mailSettings, sendMail, verifyMailTransport } from "./mail";

const USAGE = `usage: bun run check:mail [recipient]
       bun run check:mail --to <recipient>

  (no recipient)   connect + TLS + AUTH, proving the host and credentials work
  <recipient>      additionally send one test message through sendMail()

Reads SMTP_* from the environment (Bun loads .env). Exit code 0 means the whole path works.
`;

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const toIndex = argv.indexOf("--to");
const to = (toIndex >= 0 ? argv[toIndex + 1] : argv.find((a) => !a.startsWith("-")))?.trim();

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

if (!mailEnabled()) {
  console.error("SMTP is off: SMTP_HOST is unset, so nothing is mailed and new sign-ups are not asked to verify.");
  console.error("Set SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS/SMTP_FROM (see .env.example), then re-run.");
  process.exitCode = 1;
} else {
  const s = mailSettings();
  const mode = s.secure ? "implicit TLS" : "STARTTLS, if the server offers it";
  console.log(`target  ${s.host}:${s.port} (${mode}, ${s.user ? `auth as ${s.user}` : "no auth"})`);
  console.log(`sender  ${s.from}`);
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
      const stamp = new Date().toISOString();
      const body = [
        "This is a test message from bunrss.",
        "",
        `server: ${s.host}:${s.port} (${mode})`,
        `sender: ${s.from}`,
        `sent:   ${stamp}`,
      ].join("\n");
      console.log(`[2/2] send to ${to} ...`);
      try {
        await sendMail(to, `bunrss SMTP test ${stamp}`, body, `<pre>${body}</pre>`);
        console.log("  ok");
        console.log(`\nDone: ${s.host} accepted a message from ${s.from} for ${to}.`);
        console.log("If it never arrives: check spam, and that the provider authorises that sender address.");
      } catch (e) {
        process.exitCode = fail("send", e);
      }
    }
  }
}

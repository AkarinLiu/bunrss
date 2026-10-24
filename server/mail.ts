// Transactional email over SMTP. Bun ships no SMTP client, so nodemailer (pure JS, no native
// deps) handles the protocol and TLS. Configuration is env-only; whether SMTP_HOST is set is
// also what turns on forced email verification (see auth.ts).
import nodemailer, { type Transporter } from "nodemailer";
import type { Locale } from "./i18n";

/** Verification is enforced only when mail can actually be sent — otherwise new accounts would be stranded. */
export function mailEnabled(): boolean {
  return !!process.env.SMTP_HOST;
}

const IMPLICIT_TLS_PORT = 465;
/** Ports that greet in plaintext and only switch to TLS when the client asks for STARTTLS. */
const STARTTLS_PORTS = new Set([25, 587, 2525]);

/** Flags come from .env files people edit by hand, so accept true/1/yes/on, not just the literal "true". */
function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] ?? "").trim());
}

/**
 * Chooses implicit TLS vs STARTTLS. `secure: true` means "speak TLS from the first byte", which only
 * works on an implicit-TLS port: send a ClientHello to 587 and the server answers with its plaintext
 * `220` banner, surfacing as BoringSSL WRONG_VERSION_NUMBER. That pairing can never succeed, so the
 * port wins (loudly) rather than letting every verification email fail later. Unknown ports still
 * honour whatever SMTP_SECURE says, since custom implicit-TLS ports do exist.
 */
export function transportMode(port: number, stated: boolean | null): { secure: boolean; warning: string | null } {
  const implicit = port === IMPLICIT_TLS_PORT;
  if (stated !== null && stated !== implicit && (implicit || STARTTLS_PORTS.has(port))) {
    const why = implicit ? "465 is implicit TLS" : `${port} greets in plaintext and upgrades via STARTTLS`;
    return { secure: implicit, warning: `SMTP_SECURE=${stated} ignored for port ${port}: ${why}.` };
  }
  return { secure: stated ?? implicit, warning: null };
}

let transport: Transporter | null = null;

/** A malformed SMTP_PORT should fall back to the submission port, not produce a NaN connect. */
function smtpPort(): number {
  const port = Number(process.env.SMTP_PORT ?? 587);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 587;
}

/** The env's stated mode: null when SMTP_SECURE is absent, so the port can decide. */
function statedSecure(): boolean | null {
  return process.env.SMTP_SECURE === undefined ? null : envFlag("SMTP_SECURE");
}

export interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
}

/** The effective configuration, resolved the same way the transport resolves it. */
export function mailSettings(): MailSettings {
  const port = smtpPort();
  return {
    host: process.env.SMTP_HOST ?? "",
    port,
    secure: transportMode(port, statedSecure()).secure,
    user: process.env.SMTP_USER || null,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "bunrss",
  };
}

function mailEndpoint(): string {
  const { host, port, secure } = mailSettings();
  return `${host}:${port} (${secure ? "implicit TLS" : "STARTTLS"})`;
}

function getTransport(): Transporter {
  if (!transport) {
    const port = smtpPort();
    const { secure, warning } = transportMode(port, statedSecure());
    if (warning) console.warn("[mail]", warning);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587/25 use STARTTLS, which nodemailer negotiates by default.
      secure,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
      ignoreTLS: envFlag("SMTP_IGNORE_TLS"),
      tls: { rejectUnauthorized: !envFlag("SMTP_ALLOW_SELF_SIGNED") },
    });
  }
  return transport;
}

/** BoringSSL's wording for "I sent a ClientHello and got plaintext back" — almost always a port/secure mix-up. */
const TLS_MISMATCH = /WRONG_VERSION_NUMBER|ERR_SSL_WRONG_VERSION|wrong version number/i;

/** Re-labels a TLS-handshake failure with the setting that caused it; other errors pass through untouched. */
export function describeMailError(e: unknown): Error {
  const err = e as { code?: string; message?: string };
  const text = `${err?.code ?? ""} ${err?.message ?? ""}`;
  if (!TLS_MISMATCH.test(text)) return e instanceof Error ? e : new Error(String(e));
  return new Error(
    `SMTP TLS handshake failed against ${mailEndpoint()} (${err?.code ?? "?"}: ${err?.message ?? ""}). ` +
      `The server answered in plaintext, so SMTP_PORT/SMTP_SECURE disagree: 465 is implicit TLS, 587/25 start plaintext and upgrade with STARTTLS.`,
    { cause: e },
  );
}

export async function sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
  try {
    await getTransport().sendMail({
      from: mailSettings().from,
      to,
      subject,
      text,
      html,
    });
  } catch (e) {
    throw describeMailError(e);
  }
}

/** EHLO + STARTTLS + AUTH, throwing on failure — the part of `verify()` the CLI reports on. */
export async function verifyMailTransport(): Promise<void> {
  await getTransport().verify();
}

/**
 * Boot-time handshake against the configured server. Without it a bad SMTP_PORT/SMTP_SECURE only
 * surfaces as a failed verification email after someone signs up.
 */
export async function checkMailTransport(): Promise<void> {
  if (!mailEnabled()) return;
  try {
    await verifyMailTransport();
    console.log(`[mail] SMTP ready at ${mailEndpoint()}`);
  } catch (e) {
    // message only: a nodemailer stack comes with a multi-line code frame that would swamp the boot log
    console.error("[mail] SMTP check failed:", describeMailError(e).message);
  }
}

/** Verification email copy, kept next to the sender so the link and wording travel together. */
export function verificationEmail(link: string, locale: Locale): { subject: string; text: string; html: string } {
  if (locale === "en") {
    return {
      subject: "Verify your bunrss email address",
      text: `Click the link below to verify your email address (valid for 24 hours):\n${link}\n\nIf you didn't create this account, you can ignore this email.`,
      html: `<p>Click the link below to verify your email address (valid for 24 hours):</p><p><a href="${link}">${link}</a></p><p>If you didn't create this account, you can ignore this email.</p>`,
    };
  }
  return {
    subject: "验证你的 bunrss 邮箱",
    text: `请点击下面的链接验证你的邮箱（24 小时内有效）：\n${link}\n\n如果这不是你本人的操作，请忽略本邮件。`,
    html: `<p>请点击下面的链接验证你的邮箱（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如果这不是你本人的操作，请忽略本邮件。</p>`,
  };
}

export interface WatchMailItem {
  title: string | null;
  link: string | null;
  matched: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Summary email for new articles that matched a subscription's watch words. */
export function watchNotificationEmail(
  feedTitle: string,
  items: WatchMailItem[],
): { subject: string; text: string; html: string } {
  const safeLink = (link: string | null) => (link && /^https?:\/\//i.test(link) ? link : null);
  const fallback = "(无标题)";
  const text = items
    .map((i) => {
      const link = safeLink(i.link);
      return `- ${i.title || fallback}（匹配：${i.matched}）${link ? `\n  ${link}` : ""}`;
    })
    .join("\n");
  const html = items
    .map((i) => {
      const title = escapeHtml(i.title || fallback);
      const link = safeLink(i.link);
      return `<li>${link ? `<a href="${escapeHtml(link)}">${title}</a>` : title} <span style="color:#888">（匹配：${escapeHtml(i.matched)}）</span></li>`;
    })
    .join("");
  return {
    subject: `bunrss 关注词提醒：${feedTitle}（${items.length} 篇）`,
    text: `订阅源「${feedTitle}」有新文章命中你的关注词：\n\n${text}`,
    html: `<p>订阅源「${escapeHtml(feedTitle)}」有新文章命中你的关注词：</p><ul>${html}</ul>`,
  };
}

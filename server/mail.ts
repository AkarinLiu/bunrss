// Transactional email over SMTP. Bun ships no SMTP client, so nodemailer (pure JS, no native
// deps) handles the protocol and TLS. Configuration is env-only; whether SMTP_HOST is set is
// also what turns on forced email verification (see auth.ts).
import nodemailer, { type Transporter } from "nodemailer";
import type { Locale } from "./i18n";

/** Verification is enforced only when mail can actually be sent — otherwise new accounts would be stranded. */
export function mailEnabled(): boolean {
  return !!process.env.SMTP_HOST;
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587/25 use STARTTLS, which nodemailer negotiates by default.
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
      ignoreTLS: process.env.SMTP_IGNORE_TLS === "true",
      tls: { rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== "true" },
    });
  }
  return transport;
}

export function sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
  return getTransport().sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "bunrss",
    to,
    subject,
    text,
    html,
  }).then(() => undefined);
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

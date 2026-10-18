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

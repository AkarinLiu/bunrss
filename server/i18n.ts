// Server-side messages for user-facing API errors. Simplified Chinese is the source
// of truth (and the default); English is selected via the request's Accept-Language.
export type Locale = "zh-CN" | "en";

const zh = {
  "auth.invalidEmailPassword": "无效邮箱或密码过短（至少 6 位）",
  "auth.usernameRule": "用户名需为 3-32 位字母、数字、_ 或 -",
  "auth.setupDone": "已完成初始化",
  "auth.usernameTaken": "用户名已被占用",
  "auth.userCapReached": "注册用户已达上限",
  "auth.emailTaken": "邮箱已注册",
  "auth.registrationClosed": "注册已关闭",
  "auth.usernameImmutable": "用户名不可更改",
  "auth.invalidCredentials": "用户名/邮箱或密码错误",

  "library.subscriptionLimit": "订阅数量已达上限（{max}）",
  "library.starLimit": "星标数量已达上限（{max}）",
  "library.tagNameEmpty": "标签名不能为空",
  "library.tagNameTooLong": "标签名不能超过 {max} 个字符",
  "library.tagExists": "标签已存在",
  "library.tagNotFound": "标签不存在",

  "feed.invalidUrl": "无效的网址",
  "feed.unreachable": "无法访问该网址",

  "import.badJson": "无法解析导入文件（应为 FreshRSS / Tiny Tiny RSS 的 JSON）",
  "import.empty": "导入文件中没有可导入的文章",
  "import.badZip": "无法解析 ZIP 文件",

  "admin.lastAdminDemote": "不能取消最后一个管理员",
  "admin.deleteSelf": "不能删除自己",
  "admin.lastAdminDelete": "不能删除最后一个管理员",
} as const;

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "auth.invalidEmailPassword": "Invalid email, or password too short (at least 6 characters)",
  "auth.usernameRule": "Username must be 3-32 letters, digits, _ or -",
  "auth.setupDone": "Setup has already been completed",
  "auth.usernameTaken": "Username is already taken",
  "auth.userCapReached": "The registration limit has been reached",
  "auth.emailTaken": "Email is already registered",
  "auth.registrationClosed": "Registration is closed",
  "auth.usernameImmutable": "Username cannot be changed",
  "auth.invalidCredentials": "Wrong username/email or password",

  "library.subscriptionLimit": "Subscription limit reached ({max})",
  "library.starLimit": "Star limit reached ({max})",
  "library.tagNameEmpty": "Tag name cannot be empty",
  "library.tagNameTooLong": "Tag name cannot exceed {max} characters",
  "library.tagExists": "Tag already exists",
  "library.tagNotFound": "Tag not found",

  "feed.invalidUrl": "Invalid URL",
  "feed.unreachable": "Could not reach that URL",

  "import.badJson": "Could not parse the import file (FreshRSS / Tiny Tiny RSS JSON expected)",
  "import.empty": "The import file contains no articles",
  "import.badZip": "Could not read the ZIP file",

  "admin.lastAdminDemote": "Cannot remove the last admin",
  "admin.deleteSelf": "Cannot delete yourself",
  "admin.lastAdminDelete": "Cannot delete the last admin",
};

const dicts: Record<Locale, Record<MessageKey, string>> = { "zh-CN": zh, en };

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = dicts[locale][key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Reads the client's preferred language; anything that is not English falls back to Simplified Chinese. */
export function localeFrom(req: Request): Locale {
  return (req.headers.get("accept-language") ?? "").trim().toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

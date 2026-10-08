// E2E check for the first-run setup wizard. Spawns its own server on a temp DB.
// Requires the frontend to be built and a browser:
//   bun run build && bunx playwright install chromium --only-shell
import { chromium } from "playwright";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbFile = join(tmpdir(), `bunrss-e2e-${Date.now()}.db`);

// PORT=0 -> the OS picks a free port; we read it back from the server's startup line
const server = Bun.spawn(["bun", "server/index.ts"], {
  env: { ...process.env, DATABASE_URL: dbFile, PORT: "0" },
  stdout: "pipe",
  stderr: "inherit",
});

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok -", msg);
}

async function serverPort(): Promise<number> {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("server exited before it started listening");
    const m = decoder.decode(value).match(/localhost:(\d+)/);
    if (m) return Number(m[1]);
  }
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const port = await serverPort();
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    try {
      await fetch(base + "/api/setup/status");
      break;
    } catch {
      if (i > 50) throw new Error("server did not start");
      await Bun.sleep(100);
    }
  }

  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(base + "/");
  await page.waitForTimeout(300);
  check(new URL(page.url()).pathname === "/setup", "fresh instance lands on the setup wizard");

  await page.fill('input[placeholder^="用户名"]', `admin_${Date.now()}`);
  await page.fill('input[type="email"]', `admin_${Date.now()}@test.local`);
  await page.fill('input[placeholder^="密码"]', "secret123");
  await page.fill('input[placeholder="确认密码"]', "secret123");
  await page.getByRole("button", { name: "创建管理员并继续" }).click();
  await page.waitForTimeout(500);
  check(await page.getByText("添加订阅源").isVisible(), "step 1 creates the admin and advances");

  await page.locator(".suggestions button").first().click();
  await page.waitForTimeout(1500);
  check((await page.locator("button.primary").innerText()).includes("已添加 1 个"), "a suggested feed is added");

  await page.locator("button.primary").click(); // 完成
  await page.waitForTimeout(800);
  check(new URL(page.url()).pathname === "/", "finishing setup navigates to the reader");
  check(await page.locator(".app").isVisible(), "reader is rendered");

  // --------------------------------------------------------------- admin console
  await page.goto(base + "/admin");
  await page.waitForTimeout(600);
  check(await page.getByText("管理后台").isVisible(), "admin console renders");
  check((await page.locator("table tbody tr").count()) === 1, "admin console lists the single user");

  const subLimit = page.locator('input[type="number"]').first();
  await subLimit.fill("5");
  await page.getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(600);
  check((await subLimit.inputValue()) === "5", "limit is saved and reflects back");

  await page.goto(base + "/");
  await page.waitForTimeout(600);
  check((await page.locator(".quota").innerText()).includes("1 / 5"), "reader shows the subscription quota");

  check(errors.length === 0, "no console/page errors " + (errors.length ? errors.join("; ") : ""));

  console.log("\ne2e setup checks passed");
} finally {
  await browser?.close();
  server.kill();
  await Promise.race([server.exited, Bun.sleep(2000)]); // Windows sometimes ignores the signal
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbFile + suffix, { force: true });
    } catch {
      // a leftover temp file is harmless
    }
  }
}

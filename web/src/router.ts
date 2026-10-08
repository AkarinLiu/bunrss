import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import Reader from "./views/Reader.vue";
import Login from "./views/Login.vue";
import Setup from "./views/Setup.vue";
import Verify from "./views/Verify.vue";
import Settings from "./views/Settings.vue";
import Subscribe from "./views/Subscribe.vue";
import Admin from "./views/Admin.vue";
import { useAuth } from "./store";

const routes: RouteRecordRaw[] = [
  { path: "/setup", component: Setup, meta: { public: true } },
  { path: "/login", component: Login, meta: { public: true } },
  { path: "/verify", component: Verify, meta: { public: true } },
  { path: "/", component: Reader },
  { path: "/feed/:feedId(\\d+)", component: Reader },
  { path: "/category/:categoryId(\\d+)", component: Reader },
  { path: "/tag/:tagId(\\d+)", component: Reader },
  { path: "/starred", component: Reader },
  { path: "/unread", component: Reader },
  { path: "/search", component: Reader },
  { path: "/subscribe", component: Subscribe },
  { path: "/settings", component: Settings },
  { path: "/admin", component: Admin, meta: { admin: true } },
];

export const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.ready) await auth.boot();

  if (auth.needsSetup) return to.path === "/setup" ? true : "/setup";
  if (to.path === "/setup") return "/"; // already initialised
  if (auth.user && to.meta.admin && !auth.user.is_admin) return "/";
  if (auth.user) return to.path === "/login" ? "/" : true;
  if (to.meta.public) return true;
  return { path: "/login", query: to.fullPath === "/" ? undefined : { next: to.fullPath } };
});

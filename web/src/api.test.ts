import { expect, test } from "bun:test";
import { feedIconUrl, formatUptime } from "./api";

test("feedIconUrl prefers site_url origin, falls back to feed_url", () => {
  expect(feedIconUrl({ site_url: "https://blog.example.com/posts", feed_url: "https://feeds.example.net/rss" })).toBe(
    "https://blog.example.com/favicon.ico",
  );
  expect(feedIconUrl({ site_url: null, feed_url: "https://feeds.example.net/rss.xml" })).toBe(
    "https://feeds.example.net/favicon.ico",
  );
  expect(feedIconUrl({ site_url: "not a url", feed_url: "" })).toBeNull();
});

test("feedIconUrl prefers the site's declared icon over the guessed favicon", () => {
  expect(
    feedIconUrl({
      site_url: "https://blog.example.com/",
      feed_url: "https://feeds.example.net/rss",
      icon_url: "https://cdn.example.com/icon.svg",
    }),
  ).toBe("https://cdn.example.com/icon.svg");
  // an empty icon_url (looked up, none declared) falls back to /favicon.ico
  expect(feedIconUrl({ site_url: "https://blog.example.com/", feed_url: "", icon_url: "" })).toBe(
    "https://blog.example.com/favicon.ico",
  );
});

test("formatUptime renders human-readable durations", () => {
  expect(formatUptime(0)).toBe("0秒");
  expect(formatUptime(45)).toBe("45秒");
  expect(formatUptime(60)).toBe("1分钟");
  expect(formatUptime(3661)).toBe("1小时1分钟1秒");
  expect(formatUptime(90000)).toBe("1天1小时");
  expect(formatUptime(90061)).toBe("1天1小时1分钟1秒");
  expect(formatUptime(-5)).toBe("0秒");
});

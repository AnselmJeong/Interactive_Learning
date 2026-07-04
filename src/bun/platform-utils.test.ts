import { describe, expect, test } from "bun:test";
import {
  buildPlatformName,
  defaultUserDataBase,
  isPotentiallyUnavailableProjectRoot,
  openCommandForPlatform,
  pythonExecutableCandidates,
  runtimeBundleName,
} from "./platform-utils";

describe("platform utilities", () => {
  test("normalizes Electrobun and Node platform names into one bundle name", () => {
    expect(buildPlatformName("darwin")).toBe("macos");
    expect(buildPlatformName("macos")).toBe("macos");
    expect(buildPlatformName("win")).toBe("win32");
    expect(runtimeBundleName("win", "x64")).toBe("win32-x64");
  });

  test("returns Windows Python candidates without POSIX bin assumptions", () => {
    const candidates = pythonExecutableCandidates({ pythonRoot: "C:\\Learnie\\python", platform: "win", arch: "x64" }).map((path) => path.replaceAll("\\", "/"));
    expect(candidates).toContain("C:/Learnie/python/.bundle/win32-x64/runtime/python.exe");
    expect(candidates).toContain("C:/Learnie/python/.venv/Scripts/python.exe");
  });

  test("classifies removable and network roots as unsafe to purge when missing", () => {
    expect(isPotentiallyUnavailableProjectRoot("/Volumes/CourseDrive/Learnie", "macos")).toBe(true);
    expect(isPotentiallyUnavailableProjectRoot("Z:\\Learnie", "win")).toBe(true);
    expect(isPotentiallyUnavailableProjectRoot("\\\\server\\share\\Learnie", "win")).toBe(true);
  });

  test("selects platform folder open commands", () => {
    expect(openCommandForPlatform("folder", "macos").command).toBe("open");
    expect(openCommandForPlatform("folder", "win").command).toBe("explorer.exe");
    expect(openCommandForPlatform("url", "linux").command).toBe("xdg-open");
  });

  test("uses platform-specific app data fallbacks", () => {
    expect(defaultUserDataBase({ platform: "win", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" } })).toBe("C:\\Users\\me\\AppData\\Roaming");
    expect(defaultUserDataBase({ platform: "macos", env: { HOME: "/Users/me" } })).toBe("/Users/me/Library/Application Support");
  });
});

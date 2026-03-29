import { describe, expect, test } from "bun:test"
import {
  checkLatestVersion,
  isNewerVersion,
  parseSemver,
} from "../src/version-check"

describe("parseSemver", () => {
  test("parses plain semver", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3])
  })

  test("parses v-prefixed semver", () => {
    expect(parseSemver("v2.0.1")).toEqual([2, 0, 1])
  })

  test("returns null for empty string", () => {
    expect(parseSemver("")).toBeNull()
  })

  test("returns null for non-numeric parts", () => {
    expect(parseSemver("1.x.3")).toBeNull()
  })

  test("returns null for fewer than 3 parts", () => {
    expect(parseSemver("1.2")).toBeNull()
  })
})

describe("isNewerVersion", () => {
  test("returns true when major is higher", () => {
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(true)
  })

  test("returns false when major is lower", () => {
    expect(isNewerVersion("2.0.0", "1.0.0")).toBe(false)
  })

  test("returns true when minor is higher and major is equal", () => {
    expect(isNewerVersion("1.2.0", "1.3.0")).toBe(true)
  })

  test("returns false when minor is lower", () => {
    expect(isNewerVersion("1.3.0", "1.2.0")).toBe(false)
  })

  test("returns true when patch is higher and major/minor equal", () => {
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true)
  })

  test("returns false when versions are identical", () => {
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false)
  })

  test("returns false when candidate is unparseable", () => {
    expect(isNewerVersion("1.0.0", "not-semver")).toBe(false)
  })

  test("returns false when current is unparseable", () => {
    expect(isNewerVersion("bad", "1.0.0")).toBe(false)
  })

  test("handles v-prefix in candidate", () => {
    expect(isNewerVersion("0.1.0", "v0.2.0")).toBe(true)
  })
})

describe("checkLatestVersion", () => {
  test("returns updateAvailable true when newer version exists", async () => {
    const result = await checkLatestVersion("0.1.0", async () => ({
      tagName: "v0.2.0",
      htmlUrl: "https://github.com/example/release/v0.2.0",
    }))

    expect(result.updateAvailable).toBe(true)
    expect(result.latestVersion).toBe("0.2.0")
    expect(result.currentVersion).toBe("0.1.0")
    expect(result.releaseUrl).toBe("https://github.com/example/release/v0.2.0")
  })

  test("returns updateAvailable false when already on latest", async () => {
    const result = await checkLatestVersion("1.0.0", async () => ({
      tagName: "v1.0.0",
      htmlUrl: "https://github.com/example/release/v1.0.0",
    }))

    expect(result.updateAvailable).toBe(false)
  })

  test("returns updateAvailable false when ahead of latest", async () => {
    const result = await checkLatestVersion("2.0.0", async () => ({
      tagName: "v1.9.9",
      htmlUrl: "https://github.com/example/release/v1.9.9",
    }))

    expect(result.updateAvailable).toBe(false)
  })

  test("strips v prefix from latestVersion", async () => {
    const result = await checkLatestVersion("0.1.0", async () => ({
      tagName: "v1.0.0",
      htmlUrl: "https://github.com/example/release/v1.0.0",
    }))

    expect(result.latestVersion).toBe("1.0.0")
  })

  test("propagates fetch errors", async () => {
    await expect(
      checkLatestVersion("0.1.0", async () => {
        throw new Error("network error")
      })
    ).rejects.toThrow("network error")
  })
})

import { describe, expect, it } from "vitest";

import { isReadonlySqliteWriteError } from "../app/server/sqlite-errors.js";

describe("sqlite error helpers", () => {
  it("recognizes readonly sqlite write failures", () => {
    expect(
      isReadonlySqliteWriteError({
        code: "ERR_SQLITE_ERROR",
        errstr: "attempt to write a readonly database",
      }),
    ).toBe(true);

    expect(
      isReadonlySqliteWriteError({
        code: "ERR_SQLITE_ERROR",
        message: "attempt to write a readonly database",
      }),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isReadonlySqliteWriteError(new Error("boom"))).toBe(false);
    expect(
      isReadonlySqliteWriteError({
        code: "SOME_OTHER_ERROR",
        errstr: "attempt to write a readonly database",
      }),
    ).toBe(false);
  });
});

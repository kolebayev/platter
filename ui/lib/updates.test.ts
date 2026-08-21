import { describe, expect, it } from "vitest";
import { isDismissed } from "./updates";

describe("isDismissed", () => {
  it("suppresses only the exact version that was waved away", () => {
    expect(isDismissed("0.2.0", "0.2.0")).toBe(true);
  });

  it("lets a newer version through", () => {
    // The whole point of storing the version rather than a flag: declining
    // 0.2.0 must not be a standing order to never mention an update again.
    expect(isDismissed("0.2.0", "0.3.0")).toBe(false);
  });

  it("says nothing is dismissed on a first run", () => {
    expect(isDismissed(null, "0.2.0")).toBe(false);
  });
});

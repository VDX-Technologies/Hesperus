import { describe, expect, it } from "vitest";
import { checkImage, FIRMWARE_MAX_BYTES, validVersion } from "../../lib/engine/firmware";

const image = (n: number, first = 0xe9) => {
  const b = new Uint8Array(n);
  b[0] = first;
  return b;
};

describe("firmware", () => {
  it("accepts only ESP32 application images that fit one OTA slot", () => {
    expect(checkImage(image(1024))).toBeNull();
    expect(checkImage(image(100))).toMatch(/small/);
    expect(checkImage(image(FIRMWARE_MAX_BYTES + 1))).toMatch(/OTA slot/);
    expect(checkImage(image(1024, 0x50))).toMatch(/ESP32/);
  });

  it("wants versions like the node's FW_VERSION", () => {
    expect(validVersion("1.2.0")).toBe(true);
    expect(validVersion("1.2")).toBe(false);
    expect(validVersion("1.2.0-beta")).toBe(false);
    expect(validVersion("../1.2.0")).toBe(false);
  });
});

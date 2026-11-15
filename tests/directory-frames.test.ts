import { describe, expect, it } from "vitest";
import { clock, DIFF_THRESHOLD, frameSize, frameTimes, grayThumb, keepFrame, meanAbsDiff, THUMB } from "../src/app/frames.ts";

const flat = (v: number) => new Uint8Array(THUMB * THUMB).fill(v);

describe("frame skipping", () => {
  it("the first frame is always kept", () => expect(keepFrame(null, flat(0))).toBe(true));
  it("an identical screen is skipped", () => expect(keepFrame(flat(120), flat(120))).toBe(false));
  it("a small change under the threshold is skipped, a larger one is kept", () => {
    expect(keepFrame(flat(100), flat(100 + DIFF_THRESHOLD))).toBe(false);
    expect(keepFrame(flat(100), flat(100 + DIFF_THRESHOLD + 1))).toBe(true);
  });
  it("the difference is the mean of the absolute differences", () => {
    const a = flat(0), b = flat(0);
    for (let i = 0; i < 512; i++) b[i] = 100;
    expect(meanAbsDiff(a, b)).toBe(50);
    expect(meanAbsDiff(b, a)).toBe(50);
  });
  it("thumbnails of different sizes count as different", () => expect(meanAbsDiff(new Uint8Array(4), new Uint8Array(8))).toBe(255));
});

describe("thumbnail", () => {
  it("is 32 by 32 grayscale of any source size", () => {
    const w = 200, h = 100, px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 255; px[i * 4 + 1] = 255; px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; }
    const t = grayThumb(px, w, h);
    expect(t.length).toBe(1024);
    expect([...new Set(t)]).toEqual([255]);
  });
});

describe("times and size", () => {
  it("every 0.7 seconds, never past the end", () => {
    const t = frameTimes(2);
    expect(t).toEqual([0, 0.7, 1.4]);
    expect(frameTimes(0.3)).toEqual([0]);
    expect(frameTimes(NaN)).toEqual([]);
  });
  it("is at most 1000 wide and keeps the shape", () => {
    expect(frameSize(2000, 1000)).toEqual({ w: 1000, h: 500 });
    expect(frameSize(800, 600)).toEqual({ w: 800, h: 600 });
  });
  it("reads a clock", () => { expect(clock(24)).toBe("0:24"); expect(clock(112)).toBe("1:52"); });
});

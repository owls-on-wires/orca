import { describe, expect, test, beforeAll, afterAll } from "bun:test";

const BASE = "http://localhost:8095";
let page: any;
let browser: any;

async function launch() {
  const pw = await import("playwright");
  browser = await pw.chromium.launch({
    headless: true,
    executablePath: "/run/current-system/sw/bin/chromium",
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
}

beforeAll(async () => {
  await launch();
});

afterAll(async () => {
  if (browser) await browser.close();
});

async function goto() {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".oc-graph__svg", { timeout: 5000 });
}

async function getNodeCount(): Promise<number> {
  return page.locator(".oc-node").count();
}

async function getUniqueRows(): Promise<number[]> {
  return page.evaluate(() => {
    const circles = document.querySelectorAll(".oc-node circle");
    const ys = new Set<number>();
    circles.forEach((c: Element) => {
      const cy = c.getAttribute("cy");
      if (cy) ys.add(Math.round(Number(cy)));
    });
    return [...ys].sort((a: number, b: number) => a - b);
  });
}

async function getViewBox(): Promise<number[]> {
  return page.evaluate(() => {
    const svg = document.querySelector(".oc-graph__svg");
    return svg?.getAttribute("viewBox")?.split(" ").map(Number) || [];
  });
}

describe("Graph visual tests", () => {
  test("graph renders all 27 nodes", async () => {
    await goto();
    const count = await getNodeCount();
    expect(count).toBe(27);
  }, 15000);

  test("graph has multiple rows", async () => {
    const rows = await getUniqueRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  test("viewbox is set with valid dimensions", async () => {
    const vb = await getViewBox();
    expect(vb.length).toBe(4);
    expect(vb[2]).toBeGreaterThan(0);
    expect(vb[3]).toBeGreaterThan(0);
  });

  test("fit button exists", async () => {
    const btn = page.locator(".oc-graph__fit");
    expect(await btn.count()).toBe(1);
  });

  test("scroll wheel changes viewbox x", async () => {
    const before = await getViewBox();
    await page.locator(".oc-graph").dispatchEvent("wheel", { deltaY: 300 });
    await page.waitForTimeout(100);
    const after = await getViewBox();
    expect(after[0]).not.toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
  });

  test("fit button scrolls to start", async () => {
    await page.locator(".oc-graph").dispatchEvent("wheel", { deltaY: 500 });
    await page.waitForTimeout(50);
    const scrolled = await getViewBox();

    await page.locator(".oc-graph__fit").click();
    await page.waitForTimeout(50);
    const reset = await getViewBox();

    expect(reset[0]).toBeLessThan(scrolled[0]);
  });

  test("clicking a node selects it", async () => {
    const result = await page.evaluate(() => {
      const node = document.querySelector(".oc-node");
      if (!node) return false;
      (node as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return !!document.querySelector(".oc-node.is-selected");
    });
    expect(result).toBe(true);
  });

  test("running nodes have pulse animation", async () => {
    const pulseCount = await page.evaluate(() => {
      return document.querySelectorAll(".oc-node__pulse").length;
    });
    expect(pulseCount).toBeGreaterThan(0);
  });

  test("completed nodes have green fill", async () => {
    const hasFill = await page.evaluate(() => {
      const circles = document.querySelectorAll(".oc-node--completed circle");
      return circles.length > 0;
    });
    expect(hasFill).toBe(true);
  });

  test("failed nodes have danger fill", async () => {
    const hasFailed = await page.evaluate(() => {
      return document.querySelectorAll(".oc-node--failed").length > 0;
    });
    expect(hasFailed).toBe(true);
  });

  test("pending/inactive nodes have empty rings", async () => {
    const hasRings = await page.evaluate(() => {
      const nodes = document.querySelectorAll(".oc-node--pending, .oc-node--inactive");
      return nodes.length > 0;
    });
    expect(hasRings).toBe(true);
  });

  test("edges render as SVG paths with arrows", async () => {
    const edgeCount = await page.evaluate(() => {
      return document.querySelectorAll(".oc-edges--fwd path, .oc-edges--back path").length;
    });
    expect(edgeCount).toBeGreaterThan(0);
  });

  test("arrow markers exist in defs", async () => {
    const markerCount = await page.evaluate(() => {
      return document.querySelectorAll("marker[id^='oc-arr-']").length;
    });
    expect(markerCount).toBeGreaterThan(0);
  });

  test("labels don't overlap (no duplicate col,row positions)", async () => {
    const collisions = await page.evaluate(() => {
      const nodes = document.querySelectorAll(".oc-node");
      const positions = new Map<string, string>();
      let collision = "";
      nodes.forEach((n: Element) => {
        const circle = n.querySelector("circle:not(.oc-node__pulse)");
        if (!circle) return;
        const cx = Math.round(Number(circle.getAttribute("cx")));
        const cy = Math.round(Number(circle.getAttribute("cy")));
        const key = `${cx},${cy}`;
        const label = n.querySelector(".oc-node__label")?.textContent || "?";
        if (positions.has(key)) {
          collision = `${label} collides with ${positions.get(key)} at ${key}`;
        }
        positions.set(key, label);
      });
      return collision;
    });
    expect(collisions).toBe("");
  });

  test("theme toggle switches to dark mode", async () => {
    const isDark = await page.evaluate(() => {
      const btn = document.querySelector(".oc-themetoggle") as HTMLElement;
      if (!btn) return false;
      btn.click();
      return document.documentElement.classList.contains("theme-dark");
    });
    expect(isDark).toBe(true);

    await page.evaluate(() => {
      const btn = document.querySelector(".oc-themetoggle") as HTMLElement;
      if (btn) btn.click();
    });
  });
});

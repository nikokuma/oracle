import { codedError } from "./errors.mjs";
import { delay } from "./firefox.mjs";

export const MODEL_STRATEGY_VERSION = "firefox-pro-v1";

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isCurrentProLabel(value) {
  const label = normalize(value);
  const tokens = label.split(" ");
  if (!tokens.includes("pro") || tokens.includes("thinking")) return false;
  return !["5 4", "5 2", "5 1", "5 0", "gpt54", "gpt52", "gpt51", "gpt50"].some((legacy) => label.includes(legacy));
}

async function readVisibleModelSignals(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const selectors = [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[data-testid*="model-switcher"]',
      'button.__composer-pill',
      'button[aria-label*="model" i]',
      '[data-testid="model-switcher-dropdown-button"]',
    ];
    const signals = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!visible(node)) continue;
        const label = [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-testid")]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        if (label) signals.push({ selector, label });
      }
    }
    return signals;
  });
}

export async function verifyModelRequirement(page, requirement = "pro") {
  const signals = await readVisibleModelSignals(page);
  if (requirement === "current") {
    return {
      requirement,
      verified: false,
      resolvedLabel: signals[0]?.label || null,
      strategyVersion: MODEL_STRATEGY_VERSION,
      capturedAt: new Date().toISOString(),
      signals,
    };
  }
  const match = signals.find((signal) => isCurrentProLabel(signal.label));
  if (!match) {
    throw codedError(
      "MODEL_REQUIREMENT_NOT_MET",
      "The visible ChatGPT composer does not positively identify the current Pro model.",
      { safeToRetry: true, details: { signals, strategyVersion: MODEL_STRATEGY_VERSION } },
    );
  }
  return {
    requirement,
    verified: true,
    resolvedLabel: match.label,
    source: match.selector,
    strategyVersion: MODEL_STRATEGY_VERSION,
    capturedAt: new Date().toISOString(),
    signals,
  };
}

export async function ensureModelRequirement(page, requirement = "pro") {
  if (requirement === "current") return verifyModelRequirement(page, requirement);
  try {
    return await verifyModelRequirement(page, requirement);
  } catch (error) {
    if (error?.code !== "MODEL_REQUIREMENT_NOT_MET") throw error;
  }

  const button = await page.evaluateHandle(() => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const explicit = document.querySelector('button[data-testid="model-switcher-dropdown-button"], button[data-testid*="model-switcher"]');
    if (visible(explicit)) return explicit;
    return Array.from(document.querySelectorAll('button.__composer-pill, button[aria-label*="model" i]')).find((node) => {
      if (!visible(node)) return false;
      const label = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`.toLowerCase();
      return !label.includes("remove") && !label.includes("attachment");
    }) || null;
  });
  const element = button.asElement();
  if (!element) {
    await button.dispose();
    throw codedError("MODEL_REQUIREMENT_NOT_MET", "ChatGPT's visible model picker was not found; no message was sent.", { safeToRetry: true });
  }
  try {
    await element.click();
  } finally {
    await button.dispose();
  }
  await delay(300);
  const candidates = await page.evaluate(() => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"], [data-testid*="model"], [role="dialog"] button'))
      .filter(visible)
      .map((node, index) => ({ index, label: `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-testid") || ""}`.replace(/\s+/gu, " ").trim() }));
  });
  const matches = candidates.filter((candidate) => isCurrentProLabel(candidate.label));
  if (matches.length !== 1) {
    await page.keyboard.press("Escape").catch(() => undefined);
    throw codedError(
      "MODEL_REQUIREMENT_NOT_MET",
      matches.length > 1 ? "More than one visible model option matched Pro; selection is ambiguous." : "A visible Pro model option is not available in this chat or project.",
      { safeToRetry: true, details: { candidates, strategyVersion: MODEL_STRATEGY_VERSION } },
    );
  }
  const clicked = await page.evaluate((expected) => {
    const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    const visible = (node) => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const nodes = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"], [data-testid*="model"], [role="dialog"] button')).filter(visible);
    const target = nodes.find((node) => normalize(`${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-testid") || ""}`) === normalize(expected));
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }, matches[0].label);
  if (!clicked) throw codedError("MODEL_REQUIREMENT_NOT_MET", "The selected Pro option disappeared before it could be clicked.", { safeToRetry: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await verifyModelRequirement(page, requirement);
    } catch {
      await delay(250);
    }
  }
  throw codedError("MODEL_REQUIREMENT_NOT_MET", "ChatGPT did not visibly confirm Pro after selection; no message was sent.", { safeToRetry: true });
}

export const modelLabelIsProForTest = isCurrentProLabel;

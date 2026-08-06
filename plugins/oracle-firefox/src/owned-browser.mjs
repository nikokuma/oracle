function processAlive(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs) {
  if (!processAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("exit", onExit);
      child.off?.("close", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once?.("exit", onExit);
    child.once?.("close", onExit);
    const timer = setTimeout(() => finish(!processAlive(child)), Math.max(1, timeoutMs));
    timer.unref?.();
  });
}

function signalOwnedChild(child, signal) {
  if (!processAlive(child)) return false;
  try {
    child.kill?.(signal);
    if (processAlive(child)) process.kill(child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puppeteer can resolve Browser.close() while leaving its exact launched child
 * alive. Wrap only that owned child; never scan for or signal unrelated browser
 * processes.
 */
export function wrapOwnedBrowser(browser, { gracefulCloseMs = 5_000, terminateMs = 5_000 } = {}) {
  if (!browser?.close || browser.__oracleOwnedClose) return browser;
  const originalClose = browser.close.bind(browser);
  let closing = null;
  Object.defineProperty(browser, "__oracleOwnedClose", { value: true });
  browser.close = () => {
    if (closing) return closing;
    closing = (async () => {
      const child = browser.process?.() || null;
      let closeError = null;
      try {
        await Promise.race([
          Promise.resolve(originalClose()),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.max(1, gracefulCloseMs));
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        closeError = error;
      }
      if (processAlive(child)) {
        signalOwnedChild(child, "SIGTERM");
        await waitForExit(child, terminateMs);
      }
      if (processAlive(child)) {
        signalOwnedChild(child, "SIGKILL");
        await waitForExit(child, 1_000);
      }
      if (closeError) throw closeError;
    })();
    return closing;
  };
  return browser;
}

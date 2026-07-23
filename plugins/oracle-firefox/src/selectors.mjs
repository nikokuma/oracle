// Selector families and completion rules are adapted from steipete/oracle (MIT).
// See THIRD_PARTY_NOTICES.md.
export const INPUT_SELECTORS = [
  'textarea[data-id="prompt-textarea"]',
  'textarea[placeholder*="Send a message"]',
  'textarea[aria-label="Chat with ChatGPT"]',
  'textarea[aria-label="Message ChatGPT"]',
  'textarea[name="prompt-textarea"]',
  "#prompt-textarea",
  ".ProseMirror",
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][data-virtualkeyboard="true"]',
];

export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[data-testid*="composer-send"]',
  'form button[type="submit"]',
  'button[type="submit"][data-testid*="send"]',
  'button[aria-label*="Send"]',
];

export const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[data-testid="composer-stop-button"]',
  'form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])',
];

export const FINISHED_ACTIONS_SELECTOR = [
  'button[data-testid="copy-turn-action-button"]',
  'button[data-testid="good-response-turn-action-button"]',
  'button[data-testid="bad-response-turn-action-button"]',
  'button[aria-label="Share"]',
].join(", ");

export const FILE_INPUT_SELECTORS = [
  'form input[type="file"]:not([accept])',
  'input[type="file"][multiple]:not([accept])',
  'input[type="file"][multiple]',
  'input[type="file"]:not([accept])',
  'form input[type="file"][accept]',
  'input[type="file"][accept]',
  'input[type="file"]',
];

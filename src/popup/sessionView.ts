/** Renders the popup's session and usage-limit state. */
import type { LimitInfo, LimitInfoItem, PopupElements, StatusPayload } from '../common/types';

/** Renders the signed-in or signed-out session state. */
export function renderSession(elements: PopupElements, status: StatusPayload): void {
  const loggedIn = Boolean(status.loggedIn);
  elements.signedOutView.hidden = loggedIn;
  elements.signedInView.hidden = !loggedIn;
  elements.signOutButton.hidden = !loggedIn;
  elements.accountLabel.textContent = loggedIn
    ? status.accountEmail || 'Signed in to ChatGPT'
    : 'Not signed in';
  renderPlanLabel(elements, loggedIn ? status.limitInfo?.planName || '' : '');
  renderLimitInfo(elements, loggedIn ? status.limitInfo : null);
  elements.limitRefreshButton.hidden = !loggedIn;
}

/** Shows the current subscription plan label when available. */
function renderPlanLabel(elements: PopupElements, planName: string): void {
  const normalizedPlan = String(planName || '').trim();
  elements.planLabel.hidden = !normalizedPlan;
  elements.planLabel.textContent = normalizedPlan || '';
}

/** Renders the list of rate-limit items in the popup. */
function renderLimitInfo(elements: PopupElements, limitInfo: LimitInfo | null): void {
  const items = Array.isArray(limitInfo?.items) ? limitInfo.items : [];
  elements.limitList.replaceChildren();

  if (items.length === 0) {
    elements.limitList.hidden = true;
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'limit-item';
    row.textContent = formatLimitItem(item);
    elements.limitList.appendChild(row);
  }

  elements.limitList.hidden = false;
}

/** Formats one rate-limit row for popup display. */
function formatLimitItem(item: LimitInfoItem): string {
  const featureLabel = String(item.featureLabel || '').trim();
  const windowLabel = String(item.windowLabel || '').trim();
  const label = [featureLabel, windowLabel].filter(Boolean).join(' ').trim() || windowLabel || 'Limit';
  return `${label}: ${formatLimitPercent(item.leftPercent)}% left, resets ${formatResetTime(item.resetsAt)}`;
}

/** Formats a percentage while keeping whole numbers compact. */
function formatLimitPercent(value: number): string {
  const rounded = Number(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Formats a Unix timestamp as a compact local reset time string. */
function formatResetTime(unixSeconds: number): string {
  try {
    const date = new Date(Number(unixSeconds) * 1000);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    if (sameDay) {
      return `${hours}:${minutes}`;
    }

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month} ${hours}:${minutes}`;
  } catch {
    return '--:--';
  }
}

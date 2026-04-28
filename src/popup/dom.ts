/** Collects and type-checks required popup DOM elements. */
import type { PopupElements } from '../common/types';

/** Collects and type-checks all required popup DOM elements. */
export function getElements(): PopupElements {
  return {
    signedOutView: getElement('signedOutView'),
    signedInView: getElement('signedInView'),
    appVersion: getElement('appVersion'),
    accountLabel: getElement('accountLabel'),
    planLabel: getElement('planLabel'),
    limitList: getElement('limitList'),
    limitRefreshButton: getElement('limitRefreshButton'),
    authError: getElement('authError'),
    historyOutput: getElement('historyOutput'),
    historyInputImage: getElement('historyInputImage'),
    historyInputText: getElement('historyInputText'),
    historyCounter: getElement('historyCounter'),
    historyPrev: getElement('historyPrev'),
    historyNext: getElement('historyNext'),
    deleteHistoryButton: getElement('deleteHistoryButton'),
    copyInputButton: getElement('copyInputButton'),
    copyOutputButton: getElement('copyOutputButton'),
    loginButton: getElement('loginButton'),
    signOutButton: getElement('signOutButton'),
    developerLink: getElement('developerLink'),
    sourceLink: getElement('sourceLink'),
    textScanButton: getElement('textScanButton'),
    imageScanButton: getElement('imageScanButton'),
    textModelSelect: getElement('textModelSelect'),
    imageModelSelect: getElement('imageModelSelect'),
    textThinkingSelect: getElement('textThinkingSelect'),
    imageThinkingSelect: getElement('imageThinkingSelect'),
    textModelRefreshButton: getElement('textModelRefreshButton'),
    imageModelRefreshButton: getElement('imageModelRefreshButton'),
    textCustomModel: getElement('textCustomModel'),
    imageCustomModel: getElement('imageCustomModel'),
    textSystemPromptSelect: getElement('textSystemPromptSelect'),
    imageSystemPromptSelect: getElement('imageSystemPromptSelect'),
    textCustomSystemPrompt: getElement('textCustomSystemPrompt'),
    imageCustomSystemPrompt: getElement('imageCustomSystemPrompt')
  };
}

/** Returns a required popup element or throws if the markup is out of sync. */
function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required popup element: ${id}`);
  }

  return element as T;
}

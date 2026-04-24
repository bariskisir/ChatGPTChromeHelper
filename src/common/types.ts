/** Declares the shared domain types used by the popup, content, and background scripts. */
export type KnownModel = string;
export type ModelSelection = KnownModel;
export type ScanKind = 'text' | 'image';
export type HistoryEntryType = ScanKind | 'ask';
export type PageResponseType = HistoryEntryType | 'status' | 'error';
export type SystemPromptPreset = 'solver' | 'none' | 'other';
export type ResponseStyle = 'low' | 'medium' | 'high';
export type ThinkingVariant = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type TriggerAction = 'triggerTextScan' | 'triggerImageScan';
export type RepeatAction = 'repeatTextScan' | 'repeatImageScan';
export type CaptureAction = 'cropImage' | 'ocrImage';
export type CoordinateStorageKey = 'lastTextScanCoordinates' | 'lastImageScanCoordinates';
export type ModelStorageKey = 'textScanModel' | 'imageScanModel';
export type CustomModelStorageKey = 'textScanCustomModel' | 'imageScanCustomModel';
export type ThinkingVariantStorageKey = 'textScanThinkingVariant' | 'imageScanThinkingVariant';
export type SystemPromptStorageKey = 'textSystemPromptPreset' | 'imageSystemPromptPreset';
export type CustomSystemPromptStorageKey = 'textCustomSystemPrompt' | 'imageCustomSystemPrompt';

export interface SelectionCoordinates {
  startX: number;
  startY: number;
  width: number;
  height: number;
}

export interface SavedSelectionCoordinates extends SelectionCoordinates {
  savedAt: number;
}

export interface PendingOAuth {
  state: string;
  verifier: string;
  tabId?: number;
  startedAt: number;
}

export interface HistoryEntry {
  input: string;
  inputImageDataUrl: string;
  output: string;
  type: HistoryEntryType;
  createdAt: number;
}

export interface LimitInfoItem {
  id: string;
  featureLabel: string;
  windowLabel: string;
  leftPercent: number;
  usedPercent: number;
  resetsAt: number;
  windowDurationMins: number;
  limitId: string;
}

export interface LimitInfo {
  planName: string;
  items: LimitInfoItem[];
}

export interface AvailableModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  availableInPlans: string[];
  hidden: boolean;
  isDefault: boolean;
  inputModalities: ScanKind[];
  defaultThinkingVariant: ThinkingVariant;
  thinkingVariants: ThinkingVariantOption[];
}

export interface ThinkingVariantOption {
  value: ThinkingVariant;
  description: string;
}

export interface LegacyLimitInfo {
  leftPercent: number;
  usedPercent?: number;
  resetsAt: number;
  windowDurationMins: number;
  label?: string;
  planName?: string;
  plan?: string;
  planType?: string;
  subscriptionPlan?: string;
}

export type StoredLimitInfo = LimitInfo | LegacyLimitInfo | Record<string, unknown> | null;

export interface AccessContext {
  accessToken: string;
  chatgptAccountId: string | null;
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface ScanSettings {
  kind: ScanKind;
  buttonLabel: string;
  triggerAction: TriggerAction;
  repeatAction: RepeatAction;
  shortcutKey: 't' | 'i';
  repeatShortcutLabel: '1' | '2';
  coordinateKey: CoordinateStorageKey;
  modelKey: ModelStorageKey;
  customModelKey: CustomModelStorageKey;
  customModelPlaceholder: string;
  thinkingVariantKey: ThinkingVariantStorageKey;
  systemPromptPresetKey: SystemPromptStorageKey;
  customSystemPromptKey: CustomSystemPromptStorageKey;
  customSystemPromptPlaceholder: string;
  overlayFile: 'selectionOverlay.js' | 'imageSelectionOverlay.js';
  overlayLabel: string;
  minWidth: number;
  minHeight: number;
  borderColor: string;
  fillColor: string;
  captureAction: CaptureAction;
  historyType: ScanKind;
  progressMessage: string;
  responseStyle: ResponseStyle;
  solverPrompt: string;
}

export interface AreaOverlayOptions {
  mode: ScanKind;
  label: string;
  minWidth: number;
  minHeight: number;
  borderColor: string;
  fillColor: string;
}

export interface ExtensionStorage {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountEmail?: string | null;
  chatgptAccountId?: string | null;
  lastResponse?: string;
  history?: HistoryEntry[];
  historyIndex?: number;
  requestCount?: number;
  limitInfo?: StoredLimitInfo;
  availableModels?: AvailableModel[];
  codexClientVersion?: string;
  lastTextScanCoordinates?: SavedSelectionCoordinates;
  lastImageScanCoordinates?: SavedSelectionCoordinates;
  textScanModel?: ModelSelection;
  textScanCustomModel?: string;
  textScanThinkingVariant?: ThinkingVariant;
  imageScanModel?: ModelSelection;
  imageScanCustomModel?: string;
  imageScanThinkingVariant?: ThinkingVariant;
  textSystemPromptPreset?: SystemPromptPreset;
  textCustomSystemPrompt?: string;
  imageSystemPromptPreset?: SystemPromptPreset;
  imageCustomSystemPrompt?: string;
  pendingOAuth?: PendingOAuth;
  authError?: string | null;
}

export interface OkResult {
  ok: true;
}

export interface ErrorResult {
  ok: false;
  error: string;
}

export type Result<T extends object = Record<never, never>> = (OkResult & T) | ErrorResult;

export interface CropImagePayload {
  croppedImageUri: string;
}

export interface OcrImagePayload extends CropImagePayload {
  extractedText: string;
}

export type CropImageResult = Result<CropImagePayload>;
export type OcrImageResult = Result<OcrImagePayload>;

export interface StatusPayload {
  ok: true;
  loggedIn: boolean;
  accountEmail: string;
  requestCount: number;
  limitInfo: LimitInfo | null;
  availableModels: AvailableModel[];
  codexClientVersion: string;
  expiresAt: number | null;
  lastResponse: string;
  history: HistoryEntry[];
  historyIndex: number;
  textScanModel: ModelSelection;
  textScanCustomModel: string;
  textScanThinkingVariant: ThinkingVariant;
  imageScanModel: ModelSelection;
  imageScanCustomModel: string;
  imageScanThinkingVariant: ThinkingVariant;
  textSystemPromptPreset: SystemPromptPreset;
  textCustomSystemPrompt: string;
  imageSystemPromptPreset: SystemPromptPreset;
  imageCustomSystemPrompt: string;
  authError: string;
}

export interface StartLoginRequest {
  action: 'startLogin';
}

export interface SignOutRequest {
  action: 'signOut';
}

export interface GetStatusRequest {
  action: 'getStatus';
}

export interface DeleteHistoryRequest {
  action: 'deleteHistory';
}

export interface RefreshModelsRequest {
  action: 'refreshModels';
}

export interface TriggerTextScanRequest {
  action: 'triggerTextScan';
}

export interface TriggerImageScanRequest {
  action: 'triggerImageScan';
}

export interface RepeatTextScanRequest {
  action: 'repeatTextScan';
}

export interface RepeatImageScanRequest {
  action: 'repeatImageScan';
}

export interface CaptureAreaRequest {
  action: 'captureArea';
  mode: ScanKind;
  coordinates: SelectionCoordinates;
}

export type RuntimeRequest =
  | StartLoginRequest
  | SignOutRequest
  | GetStatusRequest
  | DeleteHistoryRequest
  | RefreshModelsRequest
  | TriggerTextScanRequest
  | TriggerImageScanRequest
  | RepeatTextScanRequest
  | RepeatImageScanRequest
  | CaptureAreaRequest;

export interface AuthChangedEvent {
  action: 'authChanged';
  error?: string;
}

export interface ResponseUpdatedEvent {
  action: 'responseUpdated';
  response?: string;
}

export type RuntimeEventMessage = AuthChangedEvent | ResponseUpdatedEvent;

export interface DisplayResponseMessage {
  action: 'displayResponse';
  response: string;
  type: PageResponseType;
}

export interface CropImageMessage {
  action: 'cropImage';
  imageUri: string;
  coordinates: SelectionCoordinates;
}

export interface OcrImageMessage {
  action: 'ocrImage';
  imageUri: string;
  coordinates: SelectionCoordinates;
}

export type TabMessage = DisplayResponseMessage | CropImageMessage | OcrImageMessage;

export interface PopupElements {
  signedOutView: HTMLElement;
  signedInView: HTMLElement;
  accountLabel: HTMLElement;
  planLabel: HTMLElement;
  limitList: HTMLElement;
  authError: HTMLElement;
  historyOutput: HTMLElement;
  historyInputImage: HTMLImageElement;
  historyInputText: HTMLElement;
  historyCounter: HTMLElement;
  historyPrev: HTMLButtonElement;
  historyNext: HTMLButtonElement;
  deleteHistoryButton: HTMLButtonElement;
  copyInputButton: HTMLButtonElement;
  copyOutputButton: HTMLButtonElement;
  loginButton: HTMLButtonElement;
  signOutButton: HTMLButtonElement;
  developerLink: HTMLButtonElement;
  sourceLink: HTMLButtonElement;
  textScanButton: HTMLButtonElement;
  imageScanButton: HTMLButtonElement;
  textModelSelect: HTMLSelectElement;
  imageModelSelect: HTMLSelectElement;
  textThinkingSelect: HTMLSelectElement;
  imageThinkingSelect: HTMLSelectElement;
  textModelRefreshButton: HTMLButtonElement;
  imageModelRefreshButton: HTMLButtonElement;
  textCustomModel: HTMLInputElement;
  imageCustomModel: HTMLInputElement;
  textSystemPromptSelect: HTMLSelectElement;
  imageSystemPromptSelect: HTMLSelectElement;
  textCustomSystemPrompt: HTMLTextAreaElement;
  imageCustomSystemPrompt: HTMLTextAreaElement;
}

export interface ScanControlElements {
  button: HTMLButtonElement;
  modelSelect: HTMLSelectElement;
  thinkingSelect: HTMLSelectElement;
  refreshButton: HTMLButtonElement;
  customModelInput: HTMLInputElement;
  systemPromptSelect: HTMLSelectElement;
  customSystemPromptInput: HTMLTextAreaElement;
}

export interface ScanControl extends ScanControlElements {
  settings: ScanSettings;
}

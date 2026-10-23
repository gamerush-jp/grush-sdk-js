export type GRushCode =
  | "unsupported"
  | "unavailable"
  | "timeout"
  | "rateLimited"
  | "signInRequired"
  | "consentDeclined"
  | "invalidParams"
  | "conflict"
  | "internal";

export type GRushResult<T> =
  | { ok: true; value: T; code: ""; message: "" }
  | { ok: false; value: null; code: GRushCode; message: string; retryAfterMs?: number };

export type GRushBackendKind = "web" | "mock" | "none";
export type GRushBackendSelection = "auto" | GRushBackendKind;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type GRushPlayer = {
  pseudoId: string;
  isGuest: boolean;
  profileConsent: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

export type GRushLeaderboardDefinition = {
  key: string;
  title: string;
  sort: "asc" | "desc";
  valueType: string;
  aggregation: string;
  period: string;
  minValue: number | null;
  maxValue: number | null;
};

export type GRushLeaderboardManifestEntry = {
  key: string;
  title: string;
  sort: "asc" | "desc";
  valueType: "int" | "float" | "duration_ms";
  aggregation: "best" | "last" | "sum";
  period: "all_time" | "daily" | "weekly" | "monthly";
  minValue?: number | null;
  maxValue?: number | null;
  enabled?: boolean;
};

/** ビルドの最上位に置く `grush.json` の中身。アップロードでランキングの定義になる。 */
export type GRushLeaderboardManifest = {
  $schema?: string;
  leaderboards?: GRushLeaderboardManifestEntry[];
};

export type GRushSubmitResult = {
  accepted: boolean;
  updated: boolean;
  value: number;
  rank: number | null;
  verified: false;
};

export type GRushLeaderboardEntry = {
  rank: number;
  pseudoId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isGuest: boolean;
  value: number;
  metadata: JsonValue | null;
  submittedAt: string;
  isSelf: boolean;
};

export type GRushLeaderboardPage = {
  key: string;
  title: string;
  sort: "asc" | "desc";
  valueType: string;
  period: string;
  periodKey: string;
  verified: false;
  entries: GRushLeaderboardEntry[];
  total: number;
};

export type GRushPlayerState = {
  pseudoId: string;
  payload: JsonValue;
  revision: number;
  /** 相手探しに使う任意の数値。書いていなければ `null`。 */
  rating: number | null;
  updatedAt: string;
};

export type GRushPlayerStateWriteOptions = {
  /**
   * 相手探しに使う数値（-1e9 より大きく 1e9 より小さい）。`null` で消し、省略すると今の値のまま。
   * `protocolVersion` 7 未満の GameRush では送らず、payload だけを書く。7 以上でも古い GameRush 本体では
   * rating が黙って捨てられるので、書けたかは返る状態の `rating` で確かめる。
   */
  rating?: number | null;
};

export type GRushSampleOptions = {
  /** 1〜20。省略すると 10。 */
  count?: number;
  /** `minRating` と `maxRating` は一緒に渡す。範囲を渡すと、rating の無い状態は返らない。 */
  minRating?: number;
  maxRating?: number;
};

/**
 * 受信箱のメッセージと交換所のアイテムで運べる値。文字列とオブジェクトのキーは
 * `^[A-Za-z0-9_.:-]{1,32}$` の識別子だけで、文章や画像は運べない。数値・真偽値・null と、
 * それらの配列とオブジェクト（最上位を 1 段目として 4 段まで、値は合計 64 個まで）。
 */
export type GRushPayloadValue =
  | string
  | number
  | boolean
  | null
  | GRushPayloadValue[]
  | { [key: string]: GRushPayloadValue };

export type GRushPayloadObject = { [key: string]: GRushPayloadValue };

export type GRushInboxMessage = {
  id: string;
  /** 送り手の疑似 ID。 */
  from: string;
  kind: string;
  payload: GRushPayloadObject;
  createdAt: string;
  /** 未読なら `null`。 */
  readAt: string | null;
};

export type GRushInboxPage = {
  /** 新しい順。 */
  messages: GRushInboxMessage[];
  /** 絞り込みによらない未読の数。 */
  unreadCount: number;
  /** 続きがあれば次の `list` の `cursor` に渡す。無ければ `null`。 */
  nextCursor: string | null;
};

export type GRushInboxListOptions = {
  unreadOnly?: boolean;
  /** 1〜50。省略すると 20。 */
  limit?: number;
  cursor?: string | null;
};

/** 知らない値が増えても読めるよう、文字列のまま渡す。 */
export type GRushTradeStatus = "open" | "matched" | "cancelled" | "expired" | (string & {});

export type GRushTrade = {
  id: string;
  /** 出品者の疑似 ID。消えた疑似 ID は `null`。 */
  from: string | null;
  /** 指名の出品の相手。公開の出品では `null`。 */
  to: string | null;
  /** 成立させた相手の疑似 ID。 */
  taker: string | null;
  offer: GRushPayloadObject;
  want: GRushPayloadObject;
  offerKey: string | null;
  wantKey: string | null;
  /** 受けた側が渡したもの。当事者（出品者と受けた側）にだけ入り、ほかの人には `null`。 */
  give: GRushPayloadObject | null;
  status: GRushTradeStatus;
  createdAt: string;
  expiresAt: string;
  settledAt: string | null;
};

export type GRushTradeRole = "offerer" | "taker" | (string & {});

/**
 * `receiveGive`: 出品者が `give` を受け取る。`returnOffer`: 出品者が `offer` を手元へ戻す
 * （取り下げ・期限切れ・運営の非表示）。`receiveOffer`: 受けた側が `offer` を受け取る。
 * 知らない値は反映せず、`ack` もしない。
 */
export type GRushTradeAction = "receiveGive" | "returnOffer" | "receiveOffer" | (string & {});

export type GRushPendingTrade = GRushTrade & { role: GRushTradeRole; action: GRushTradeAction };

export type GRushMyTrades = {
  /** 自分の受付中の出品。 */
  open: GRushTrade[];
  /** 終わったが、まだ `ack` していない取引（終わった順）。 */
  pending: GRushPendingTrade[];
};

export type GRushTradeOutcome = "matched" | "taken" | "expired" | "cancelled" | "notFound";

export type GRushTradeAcceptResult = {
  outcome: GRushTradeOutcome;
  /** `matched` のときの取引。 */
  trade: GRushTrade | null;
};

export type GRushTradeCreateOptions = {
  /** 出すもの。詰めた JSON で 2KB まで。 */
  offer: GRushPayloadObject;
  /** 欲しいもの。詰めた JSON で 1KB まで。 */
  want: GRushPayloadObject;
  /** 一覧の絞り込みに使う識別子（`^[A-Za-z0-9._:-]{1,32}$`）。 */
  offerKey?: string;
  wantKey?: string;
  /** 指名の出品の相手の疑似 ID。省略すると公開の出品。 */
  to?: string;
  /** 600〜604800 秒。省略すると 3 日。 */
  expiresInSec?: number;
  /**
   * 出品の識別子（`^[A-Za-z0-9._:-]{1,64}$`）。同じ値の再送は、中身によらず先に作った出品を返す。
   * 呼ぶ前にセーブへ保存し、応答が失われたら同じ値で呼び直す。
   */
  operationId: string;
};

export type GRushTradeListOptions = {
  offerKey?: string;
  wantKey?: string;
  /** 1〜50。省略すると 20。 */
  limit?: number;
  cursor?: string | null;
};

export type GRushTradePage = {
  /** 他人の公開の出品と自分宛ての指名の出品のうち、受付中のもの（新しい順）。 */
  trades: GRushTrade[];
  nextCursor: string | null;
};

/**
 * セーブの置き場所。`"local"` は、GameRush がプレイヤーのサインインを確かめられず、端末
 * （ブラウザの保存領域）に置いたことを表す。`fallback: "local"` を渡したときだけ現れる。
 */
export type GRushCloudSaveStorage = "cloud" | "local";

export type GRushCloudSave = {
  slot: string;
  payload: JsonValue;
  /** クラウドの版。1 から増える。端末のセーブは常に 0。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
  storage: GRushCloudSaveStorage;
};

/**
 * `"local"` を渡すと、GameRush がサインインを確かめられないとき（クラウドなら `signInRequired`
 * になるとき）だけ、端末に読み書きする。ほかの失敗では切り替えない。端末のセーブはブラウザが
 * 消すことがある。`protocolVersion` 5 未満の GameRush では無視され、渡さないときと同じになる。
 */
export type GRushCloudSaveFallback = "local";

export type GRushCloudSaveOptions = { fallback?: GRushCloudSaveFallback };
export type GRushCloudSaveWriteOptions = GRushCloudSaveOptions & {
  /**
   * 前に読んだ `revision`。クラウドの版がこれと違えば `conflict` で書かない。`0` は「クラウドに
   * まだ無いときだけ書く」。端末への書き込みでは見ない（最後の書き込みが勝つ）。
   */
  baseRevision?: number;
};

export type GRushShareImage =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | HTMLCanvasElement
  | string
  | { base64: string; mimeType: string }
  | "screen";

export type GRushShareOptions = {
  text?: string;
  image?: GRushShareImage;
  /**
   * 共有リンクに添える起動パラメータ。受け取った人がリンクを開くと、ゲームの `launch` に渡る
   * （`{ stage: "3" }` ならリンクに `?gp.stage=3` が付く）。キーは英数字と `_-` で 32 文字まで
   * （`__proto__` は使えない）、値は英数字と `._~:,-` で 128 文字まで（空も可）、8 個まで。1つでも
   * 合わなければ共有を開かずに `invalidParams`。空のオブジェクトは渡さないときと同じ。
   *
   * `protocolVersion` 9 未満の GameRush では、空でなければ共有を開かずに `unsupported` を返す。
   * パラメータを外して呼び直せば共有できる。
   *
   * リンクは誰にでも見え、そのまま転送されるので、プレイヤーを識別できる値（招待コードなど）を入れない。
   * 受け取る側のゲームは値を信用せず、確かめてから使う。
   */
  launchParams?: Record<string, string>;
};
export type GRushShareStatus = "opened" | "cancelled";
export type GRushShareResult = { status: GRushShareStatus };

export type GRushLocaleSource = "user" | "system" | "device" | (string & {});
export type GRushLocale = {
  locale: string;
  source: GRushLocaleSource;
  languages: string[];
};

/**
 * 起動パラメータ。GameRush の URL に `gp.` を付けて載せたキーと値（`?gp.item=sword` なら
 * `{ item: "sword" }`）。キーは英数字と `_-` で 32 文字まで（`__proto__` は使えない）、
 * 値は英数字と `._~:,-` で 128 文字まで、8 個まで。形の合わないものは GameRush が落とす。
 */
export type GRushLaunch = {
  params: Record<string, string>;
};

/**
 * 分析イベントの custom field。3つまで。キーは英数字と `_` で 32 文字まで。値は1行のテキストで
 * 40 文字（コードポイント）まで。改行と制御文字は空白に直してから数え、直した結果が空の値は拒まれる。
 */
export type GRushAnalyticsFields = { [key: string]: string };
export type GRushAnalyticsOptions = { fields?: GRushAnalyticsFields };
export type GRushEconomyFlowType = "source" | "sink";
/** GameRush の標準の取引の種類。ほかの値（英数字と `._:-` で 32 文字まで）も受ける。 */
export type GRushEconomyTransactionType =
  | "TimedReward"
  | "Onboarding"
  | "Shop"
  | "Gameplay"
  | "ContextualPurchase"
  | (string & {});
export type GRushEconomyOptions = GRushAnalyticsOptions & {
  /** 品目。1行のテキストで 40 文字まで。 */
  itemSku?: string;
};

/** 確かめて作り直した分析イベント。`mock.analyticsEvents()` が返す。 */
export type GRushAnalyticsEvent =
  | { kind: "onboarding"; step: number; stepName?: string; fields?: GRushAnalyticsFields }
  | {
      kind: "funnel";
      funnel: string;
      funnelSessionId?: string;
      step: number;
      stepName?: string;
      fields?: GRushAnalyticsFields;
    }
  | { kind: "custom"; name: string; value: number; fields?: GRushAnalyticsFields }
  | {
      kind: "economy";
      flowType: GRushEconomyFlowType;
      currency: string;
      amount: number;
      endingBalance: number;
      transactionType: string;
      itemSku?: string;
      fields?: GRushAnalyticsFields;
    };

export type GRushPeer = {
  index: number;
  pseudoId: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type GRushChannel = "reliable" | "unreliable";
export type GRushPayload = ArrayBuffer | ArrayBufferView | string;
export type GRushSendOptions = { channel?: GRushChannel; to?: number };

export type GRushMessage = {
  from: number;
  channel: GRushChannel;
  seq: number;
  payload: ArrayBuffer;
  isStale: boolean;
  text(): string;
  json(): unknown;
};

export type GRushRoomEvents = {
  message: GRushMessage;
  peerjoin: GRushPeer;
  peerleave: { index: number };
  host: { index: number };
  transportchange: { transport: string };
  /** 部屋が1通を捨てたときに届く。部屋はつながったままで、続けて送れる。 */
  error: { code: GRushRoomErrorCode; message: string };
  close: { reason: string };
};

/** 部屋が1通を捨てた理由。ここに無いコードが届くこともある。 */
export type GRushRoomErrorCode = "messageTooLarge" | "rateLimited" | "badFrame" | (string & {});

export interface GRushRoom {
  readonly roomId: string;
  readonly roomCode: string;
  readonly roomEpoch: number;
  readonly localPeerId: number;
  readonly peers: GRushPeer[];
  readonly hostPeerId: number;
  readonly transport: string;
  readonly isClosed: boolean;
  isHost(): boolean;
  serverTimeMs(): number;
  lastSeqFrom(peerId: number): number;
  on<K extends keyof GRushRoomEvents>(
    name: K,
    handler: (event: GRushRoomEvents[K]) => void,
  ): () => void;
  send(payload: GRushPayload, options?: GRushSendOptions): GRushResult<true>;
  sendJson(value: unknown, options?: GRushSendOptions): GRushResult<true>;
  leave(): Promise<GRushResult<true>>;
}

export type GRushMockConfig = {
  signedIn: boolean;
  displayName: string;
  avatarUrl: string | null;
  grantProfileConsent: boolean;
  confirmPlayerStateReport: boolean;
  /** 受信箱の通報の確認でプレイヤーが押す答え。 */
  confirmInboxReport: boolean;
  /** 交換所の通報の確認でプレイヤーが押す答え。 */
  confirmTradeReport: boolean;
  unreliableDropRate: number;
  maxPeers: number;
  shareAvailable: boolean;
  shareStatus: GRushShareStatus;
  locale: string | null;
  /** `launch` が返す起動パラメータ。モックは GameRush の制限で確かめずにそのまま返す。 */
  launchParams: Record<string, string>;
};

export interface GRushMockPeer {
  readonly index: number;
  readonly pseudoId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  on(name: "message", handler: (message: GRushMessage) => void): () => void;
  send(payload: GRushPayload, options?: GRushSendOptions): void;
}

export interface GRushMock {
  config: GRushMockConfig;
  defineLeaderboard(
    key: string,
    options?: Partial<Omit<GRushLeaderboardDefinition, "key">> & { enabled?: boolean },
  ): void;
  /**
   * `grush.json` の中身（オブジェクトか JSON の文字列）でモックの枠を宣言し、宣言した key を返す。
   * アップロードと同じ規則で読み、誤りは `invalidParams` で返す。同じ key を `defineLeaderboard` で
   * 宣言してあっても、こちらの定義で置き換える。これを呼ぶと、ページの隣の `grush.json` は自動では読まない。
   */
  loadLeaderboards(manifest: GRushLeaderboardManifest | string): GRushResult<string[]>;
  addRival(
    key: string,
    displayName: string,
    value: number,
    options?: { avatarUrl?: string | null; isGuest?: boolean },
  ): void;
  definePlayerState(
    pseudoId: string,
    payload: JsonValue,
    options?: { hidden?: boolean; rating?: number | null },
  ): void;
  /**
   * `playerState.onPreview` の `handler` に、確認用の表示の状態を渡す。渡すのは呼び出しの後（非同期）で、
   * `handler` が無ければ次に登録したときに渡す。`revision` は省略すると 1、`rating` は省略すると `null`。
   * 形が合わなければ何もせず `false`。
   */
  previewPlayerState(
    pseudoId: string,
    payload: { [key: string]: JsonValue },
    options?: { revision?: number; rating?: number | null },
  ): boolean;
  /**
   * モックの相手の疑似 ID。それぞれ rating 付きの公開プレイヤー状態を持ち、届いたメッセージを同じ
   * `kind` と `payload` で送り返す。`reset()` の後は、最初の相手からのメッセージ1通と、受付中の出品を2件持つ。
   */
  readonly rivals: readonly string[];
  /** `from` から自分の受信箱へメッセージを届ける。形が受信箱の縛りに合わなければ `false`。 */
  receiveInbox(from: string, kind: string, payload: GRushPayloadObject): boolean;
  /** `from` の出品を作る。`toSelf` で自分宛ての指名の出品になる。形が縛りに合わなければ `null`。 */
  offerTrade(
    from: string,
    offer: GRushPayloadObject,
    want: GRushPayloadObject,
    options?: { offerKey?: string; wantKey?: string; toSelf?: boolean; expiresInSec?: number },
  ): GRushTrade | null;
  /** 自分の出品を `by`（省略すると最初の相手）が受ける。結果は受諾の `outcome` と同じ。 */
  acceptTrade(tradeId: string, give: GRushPayloadObject, by?: string): GRushTradeOutcome;
  /** 受付中の出品をいま期限切れにする。 */
  expireTrade(tradeId: string): boolean;
  addPeer(displayName: string, avatarUrl?: string | null): GRushMockPeer | null;
  removePeer(peer: GRushMockPeer): void;
  /**
   * 自分がいる部屋に、部屋が1通を捨てたときの `error` を届ける。届け方は本番と同じく非同期で、
   * 部屋は閉じない。部屋にいなければ何もせず `false` を返す。
   */
  raiseRoomError(code: GRushRoomErrorCode, message: string): boolean;
  /** モックが受けた分析イベントの写し。直近の 200 件を古い順に返す。`reset()` で空になる。 */
  analyticsEvents(): GRushAnalyticsEvent[];
  reset(): void;
}

export interface GRushSdk {
  readonly VERSION: string;
  readonly CODES: { readonly [K in GRushCode]: K };
  readonly CHANNEL_RELIABLE: "reliable";
  readonly CHANNEL_UNRELIABLE: "unreliable";
  readonly EVERYONE: -1;
  readonly MAX_MESSAGE_BYTES: number;
  readonly backend: GRushBackendKind;
  configure(settings: { backend?: GRushBackendSelection }): void;
  isAvailable(): boolean;
  protocolVersion(): number;
  player: {
    getSelf(): Promise<GRushResult<GRushPlayer>>;
    requestProfile(): Promise<GRushResult<GRushPlayer>>;
    revokeProfile(): Promise<GRushResult<GRushPlayer>>;
  };
  leaderboards: {
    list(): Promise<GRushResult<GRushLeaderboardDefinition[]>>;
    submit(
      key: string,
      value: number,
      options?: { metadata?: JsonValue; operationId?: string },
    ): Promise<GRushResult<GRushSubmitResult>>;
    top(
      key: string,
      options?: { limit?: number; offset?: number },
    ): Promise<GRushResult<GRushLeaderboardPage>>;
    aroundMe(key: string, options?: { range?: number }): Promise<GRushResult<GRushLeaderboardPage>>;
    friends(key: string, options?: { limit?: number }): Promise<GRushResult<GRushLeaderboardPage>>;
  };
  playerState: {
    getMine(): Promise<GRushResult<GRushPlayerState | null>>;
    setMine(
      payload: { [key: string]: JsonValue },
      baseRevision?: number,
      options?: GRushPlayerStateWriteOptions,
    ): Promise<GRushResult<GRushPlayerState>>;
    get(pseudoIds: string[]): Promise<GRushResult<GRushPlayerState[]>>;
    report(pseudoId: string): Promise<GRushResult<boolean>>;
    /**
     * 相手探し。同じゲームの他プレイヤーの公開状態をランダムに返す。自分と運営が伏せた状態は返らず、
     * 名前も返らない。`protocolVersion` 7 未満の GameRush では `unsupported`。
     */
    sample(options?: GRushSampleOptions): Promise<GRushResult<GRushPlayerState[]>>;
    /**
     * GameRush の確認用の表示で、ある公開プレイヤー状態がほかのプレイヤーにどう見えるかを描くよう頼まれたときに
     * `handler` を呼ぶ。他プレイヤーの状態を描くときと同じ見た目で描く。返り値は解除関数。
     *
     * 同じ状態は1回だけ渡る。登録より先に届いていた状態は、登録したときに渡る。それより後に足した `handler` には
     * 渡らないので、起動したらすぐ登録する。`handler` が例外を投げると、GameRush には描けなかったと伝わる。
     * ふだんのプレイでは呼ばれない。`protocolVersion` 10 未満の GameRush と GameRush の外では呼ばれない。
     * `configure({ backend })` でバックエンドを切り替えても購読は続く。
     */
    onPreview(handler: (state: GRushPlayerState) => void): () => void;
  };
  /**
   * 受信箱。同じゲームの疑似 ID 宛てに、小さい構造化メッセージ（非同期対戦の結果の通知など）を送り、
   * 受け取る。`payload` の文字列は識別子だけで、文章や画像は送れない（{@link GRushPayloadValue}）。
   * 利用者どうしの文章や画像のやりとりには使わない。`protocolVersion` 7 未満の GameRush では `unsupported`。
   */
  inbox: {
    /**
     * 詰めた JSON で 1KB までの `payload` を送る。`kind` は `^[A-Za-z0-9._:-]{1,32}$`。
     * 同じゲームの疑似 ID でない宛先は `invalidParams`、送りすぎ（毎時・毎日の上限）は `rateLimited` で、時間が経てば
     * 回復する。待つ時間が分かれば `retryAfterMs` が入る。
     */
    send(to: string, kind: string, payload: GRushPayloadObject): Promise<GRushResult<boolean>>;
    list(options?: GRushInboxListOptions): Promise<GRushResult<GRushInboxPage>>;
    /** 既読にし、更新した件数を返す（50 件まで）。 */
    markRead(ids: string[]): Promise<GRushResult<number>>;
    /** 消し、消した件数を返す（50 件まで）。 */
    remove(ids: string[]): Promise<GRushResult<number>>;
    /**
     * メッセージを通報する。確認は GameRush が出し、承諾されたら `true`。通報すると送り手を
     * ブロックし、その相手のメッセージと出品は見えなくなる。ゲストは `signInRequired`。
     */
    report(messageId: string): Promise<GRushResult<boolean>>;
  };
  /**
   * 交換所。プレイヤーがアイテムを出品し、同じゲームの別のプレイヤーが受ける。アイテムの正当性は
   * GameRush が確かめず、交換が片方だけ成立しないことと、終わった取引を取りこぼさないことだけを保証する。
   * `offer`・`want`・`give` の文字列は識別子だけで、文章や画像は送れない（{@link GRushPayloadValue}）。
   * 利用者どうしの文章や画像のやりとりには使わない。
   *
   * 取りこぼさないために、次の順で使う。
   * 1. 出品の前に、出すアイテムを手元のセーブで仮置き（使えない状態）にする。
   * 2. `operationId` をセーブに保存してから `create` する。
   * 3. 応答が失われたら、同じ `operationId` で `create` を呼び直す。
   * 4. `mine()` の `pending` をセーブに反映し、クラウドセーブに保存してから `ack` する。
   * 5. 反映済みの取引 ID をセーブに持ち、同じ取引を二度反映しない。
   *
   * `protocolVersion` 7 未満の GameRush では `unsupported`。
   */
  trade: {
    /**
     * 受付中の出品が 10 件あるときは `invalidParams`（待っても直らない。取り下げるか、成立・期限切れを待つ）。
     * 毎日 30 件の出品の上限は `rateLimited` で、時間が経てば回復する。待つ時間が分かれば `retryAfterMs` が入る。
     */
    create(options: GRushTradeCreateOptions): Promise<GRushResult<GRushTrade>>;
    list(options?: GRushTradeListOptions): Promise<GRushResult<GRushTradePage>>;
    mine(): Promise<GRushResult<GRushMyTrades>>;
    /**
     * 出品を受ける。先に取られた・期限切れ・取り下げ・見えない出品はエラーではなく `outcome` で返る。
     * 同じ取引への再送は `matched` を返す。`give` は詰めた JSON で 2KB まで。
     */
    accept(tradeId: string, give: GRushPayloadObject): Promise<GRushResult<GRushTradeAcceptResult>>;
    /** 自分の受付中の出品を取り下げる。終わっていれば今の状態を返す。 */
    cancel(tradeId: string): Promise<GRushResult<GRushTrade>>;
    /** `pending` の取引の受け取りを確かめ、記録した件数を返す（50 件まで）。 */
    ack(ids: string[]): Promise<GRushResult<number>>;
    /**
     * 出品を通報する。確認は GameRush が出し、承諾されたら `true`。通報すると出品者をブロックし、
     * その相手のメッセージと出品は見えなくなる。ゲストは `signInRequired`。
     */
    report(tradeId: string): Promise<GRushResult<boolean>>;
  };
  cloudSave: {
    /**
     * スロットのセーブを読む。無ければ `null`。`fallback: "local"` のとき、サインイン済みでクラウドに
     * 無ければ端末のセーブを返す。別のアカウントのものと分かっている端末のセーブは返さず、どのアカウントか
     * 分からないまま書いたものは返す。サインインを確かめられないときは、どのアカウントで書いたかに関係なく
     * 端末のセーブを返す。
     */
    load(
      slot?: string,
      options?: GRushCloudSaveOptions,
    ): Promise<GRushResult<GRushCloudSave | null>>;
    /**
     * スロットへ書く。`fallback: "local"` のとき、クラウドへ書けたら、同じスロットの、このプレイヤーの
     * 端末のセーブと、どのアカウントのものか分からない端末のセーブを消す。
     * サインイン後の書き込みが `conflict` になったら、`load` してから書き直す。
     */
    save(
      payload: JsonValue,
      slot?: string,
      options?: GRushCloudSaveWriteOptions,
    ): Promise<GRushResult<GRushCloudSave>>;
    /**
     * スロットを消す。`fallback: "local"` のとき、クラウドで消せたら、同じスロットの、このプレイヤーの
     * 端末のセーブと、どのアカウントのものか分からない端末のセーブも消す。サインインを確かめられない
     * ときは、どのアカウントで書いたかに関係なく端末のセーブを消す。
     */
    remove(slot?: string, options?: GRushCloudSaveOptions): Promise<GRushResult<true>>;
  };
  share: {
    share(options?: GRushShareOptions): Promise<GRushResult<GRushShareResult>>;
    isAvailable(): Promise<boolean>;
  };
  locale: {
    get(): Promise<GRushResult<GRushLocale>>;
    current(): GRushLocale | null;
    /**
     * 表示言語が変わったときに `handler` を呼ぶ。返り値は解除関数。
     * `configure({ backend })` でバックエンドを切り替えても購読は続く。
     */
    onChange(handler: (locale: GRushLocale) => void): () => void;
  };
  /**
   * 起動パラメータ。シェアしたリンクから特定のアイテムやステージへ飛ばすのに使う。
   *
   * 値は誰でも作れるリンクから来る。存在するか・持っているか・解放済みかをゲームの側で確かめてから使い、
   * 確かめられなければ無視する。
   *
   * 渡るのは、プレイヤーが最初に開いたスライドのゲームだけ。別のゲームへスワイプして戻ったときは空。
   * フィードではページを読み直すと空になるが、単体表示や埋め込みでは読み直すと同じ値がまた渡ることが
   * あるので、何度渡っても困らないように書く。`protocolVersion` 8 未満の GameRush と GameRush の外では、`get` は
   * `unsupported`、`current` は `null`。
   */
  launch: {
    /** 起動パラメータが届くまで待って返す。パラメータの無い起動では `params` が空。 */
    get(): Promise<GRushResult<GRushLaunch>>;
    /** 届いていれば起動パラメータ、まだなら `null`（同期。結果オブジェクトではない）。 */
    current(): GRushLaunch | null;
  };
  /**
   * 作者のアナリティクスへ送るイベント。ほかの API と違い、どれも同期で `boolean` を返し、例外を投げない。
   * `true` は GameRush へ渡したことで、保存されたことではない。形が不正なとき、`protocolVersion` 6 未満の
   * GameRush、GameRush の外では `false`。名前・値・field にプレイヤーを識別できる情報を入れない。
   *
   * `true` でも保存されないもの: 前面に出るまでに溜めた 30 件を超えた分（これは `false`）のほか、前面に出た後に
   * GameRush 本体が掛ける上限（500ms に1件、まとめて最大 30 件、送る前の列は合計 200 件）を超えた分、
   * セッションあたりの上限（オンボーディングを含むファネルのステップ 200 件・カスタムイベント 500 件・
   * エコノミー 500 件）を超えた分、送れなかった分。オンボーディングとファネルの同じステップは、1セッション
   * （ページを読み直しても続く）で最初の1回だけが残る。
   */
  analytics: {
    /** オンボーディングのステップ。`step` は 1〜100 の整数。 */
    logOnboardingStep(
      step: number,
      stepName?: string | null,
      options?: GRushAnalyticsOptions,
    ): boolean;
    /**
     * ファネルのステップ。`funnel` と `funnelSessionId` は英数字と `._:-` で 64 文字まで。同じファネルを
     * 1つのプレイで何度も通るなら、通るたびに別の `funnelSessionId` を渡す。
     */
    logFunnelStep(
      funnel: string,
      funnelSessionId: string | null | undefined,
      step: number,
      stepName?: string | null,
      options?: GRushAnalyticsOptions,
    ): boolean;
    /** カスタムイベント。`value` は省略で 1、絶対値 1e9 まで。 */
    logCustomEvent(name: string, value?: number, options?: GRushAnalyticsOptions): boolean;
    /**
     * 通貨の入手（`"source"`）と消費（`"sink"`）。`amount` は正の値、`endingBalance` はその後の残高で必須。
     * `currency` と `transactionType` は英数字と `._:-` で 32 文字まで。
     */
    logEconomyEvent(
      flowType: GRushEconomyFlowType,
      currency: string,
      amount: number,
      endingBalance: number,
      transactionType: GRushEconomyTransactionType,
      options?: GRushEconomyOptions,
    ): boolean;
    /** GameRush の中で動いていて、分析イベントを送れるか。 */
    isAvailable(): boolean;
  };
  net: {
    join(options?: { mode?: string; roomCode?: string }): Promise<GRushResult<GRushRoom>>;
    readonly room: GRushRoom | null;
  };
  mock: GRushMock;
}

export declare const VERSION: string;
export declare const CODES: GRushSdk["CODES"];
export declare function createGRush(options?: { backend?: GRushBackendSelection }): GRushSdk;
export declare const GRush: GRushSdk;
export default GRush;

declare global {
  interface Window {
    GRush: GRushSdk;
    GRushSdk: GRushSdk;
  }
}

# GameRush SDK for JavaScript

GameRush の GameAPI（ランキング・公開プレイヤー状態と相手探し・受信箱・交換所・クラウドセーブ・共有・表示言語・起動パラメータ・アナリティクス・リアルタイム対戦）を、素の `index.html` のゲームから呼ぶためのラッパー。バンドラ不要で、script タグ 1 行でも ES Modules の `import` でも使える。使い方の正（投稿が弾かれる条件とエラーコード・API トークン）は [SDK ガイド](https://gamerush.jp/sdk)。

GameRush はアップロードされた全ビルドへランタイム JS（`window.GRushPlayer` など）を注入している。この SDK はその上に薄く乗り、次の 3 つを足す。

- **例外を投げない。** すべての API が `{ ok, value, code, message }` を返す（アナリティクスと、表に書いた同期の呼び出しを除く）。GameRush の外では `code: "unsupported"` になるだけで、ゲームは止まらない
- **ローカルで動く。** `localhost` と `file://` では自動でモックに切り替わり、アップロードせずにランキングや対戦を試せる
- **形がそろう。** 名前・アバターは同意がある時だけ入り、`verified` は常に `false`（スコアは自己申告）

## 導入

どれか 1 つ。

```bash
git submodule add https://github.com/gamerush-jp/grush-sdk-js.git vendor/grush-sdk-js
```

```html
<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@v0.12.0/grush-sdk.js"></script>
```

CDN から読むときは版を固定すること（`@main` だと、アップロード済みのビルドの挙動が後から変わる）。

`grush-sdk.js`（グローバル版）か `grush-sdk.mjs`（ESM 版）をゲームのフォルダへコピーするだけでもよい。依存は無い。

## 使い方

### script タグ

```html
<script src="vendor/grush-sdk-js/grush-sdk.js"></script>
<script>
  GRush.leaderboards.submit("score", 1200).then((result) => {
    if (result.ok) console.log("rank", result.value.rank);
    else console.log("not sent", result.code);
  });
</script>
```

`window.GRush` に入る（同名のグローバルが既にあるときは上書きせず、`window.GRushSdk` だけに入る）。

### ES Modules

```html
<script type="module">
  import GRush from "./vendor/grush-sdk-js/grush-sdk.mjs";

  const self = await GRush.player.getSelf();
  if (self.ok) console.log(self.value.pseudoId);
</script>
```

TypeScript の型は `grush-sdk.d.ts`。

## API

| 呼び出し | 返る `value` |
|---|---|
| `GRush.player.getSelf()` / `requestProfile()` / `revokeProfile()` | `{ pseudoId, isGuest, profileConsent, displayName, avatarUrl }` |
| `GRush.leaderboards.list()` | ランキング定義の配列（定義は Studio かビルドの `grush.json` で作者が宣言する） |
| `GRush.leaderboards.submit(key, value, { metadata, operationId })` | `{ accepted, updated, value, rank, verified }` |
| `GRush.leaderboards.top(key, { limit, offset })` / `aroundMe(key, { range })` / `friends(key, { limit })` | `{ key, title, entries, total, verified, ... }` |
| `GRush.playerState.getMine()` / `setMine(payload, baseRevision, { rating })` / `get(pseudoIds)` / `report(pseudoId)` | `{ pseudoId, payload, revision, rating, updatedAt }` など |
| `GRush.playerState.sample({ count, minRating, maxRating })` | 他プレイヤーの公開状態の配列（相手探し。下記） |
| `GRush.playerState.onPreview(handler)` | 解除関数（確認用の表示で、公開状態を描くよう頼まれたときに `handler` を呼ぶ。下記） |
| `GRush.inbox.send(to, kind, payload)` / `list({ unreadOnly, limit, cursor })` / `markRead(ids)` / `remove(ids)` / `report(messageId)` | `true` / `{ messages, unreadCount, nextCursor }` / 件数 / 件数 / 承諾されたか（下記） |
| `GRush.trade.create({ offer, want, offerKey, wantKey, to, expiresInSec, operationId })` / `list(...)` / `mine()` / `accept(tradeId, give)` / `cancel(tradeId)` / `ack(ids)` / `report(tradeId)` | 出品 / `{ trades, nextCursor }` / `{ open, pending }` / `{ outcome, trade }` / 出品 / 件数 / 承諾されたか（下記） |
| `GRush.cloudSave.load(slot, { fallback })` / `save(payload, slot, { baseRevision, fallback })` / `remove(slot, { fallback })` | `{ slot, payload, revision, createdAt, updatedAt, storage }` など（下記） |
| `GRush.share.share({ text, image, launchParams })` | `{ status: "opened" \| "cancelled" }`（下記） |
| `GRush.share.isAvailable()` | `true` / `false`（結果オブジェクトではなく真偽値。失敗しない） |
| `GRush.locale.get()` | `{ locale, source, languages }`（下記） |
| `GRush.locale.current()` | 同じ形、または `null`（同期。結果オブジェクトではない） |
| `GRush.locale.onChange(handler)` | 解除関数（表示言語が決まったとき・変わったときに `handler` を呼ぶ） |
| `GRush.launch.get()` | `{ params }`（起動パラメータ。下記） |
| `GRush.launch.current()` | 同じ形、または `null`（同期。結果オブジェクトではない） |
| `GRush.analytics.logOnboardingStep(step, stepName, { fields })` | `true` / `false`（同期。下記） |
| `GRush.analytics.logFunnelStep(funnel, funnelSessionId, step, stepName, { fields })` | `true` / `false`（同期） |
| `GRush.analytics.logCustomEvent(name, value = 1, { fields })` | `true` / `false`（同期） |
| `GRush.analytics.logEconomyEvent(flowType, currency, amount, endingBalance, transactionType, { itemSku, fields })` | `true` / `false`（同期） |
| `GRush.analytics.isAvailable()` | `true` / `false`（同期） |
| `GRush.net.join({ mode, roomCode })` | 部屋（下記） |

失敗時の `code` は `unsupported` / `unavailable` / `timeout` / `rateLimited`（`retryAfterMs` 付き）/ `signInRequired` / `consentDeclined` / `invalidParams` / `conflict`（クラウドセーブの版ずれ）/ `internal`。

集約が `sum` のランキングへ投稿を再送するときは、必ず同じ `operationId` を渡すこと。渡さないと二重に加算される。

### クラウドセーブ

```js
const loaded = await GRush.cloudSave.load("default", { fallback: "local" });
if (loaded.ok) {
  const revision = loaded.value?.revision ?? 0;
  const saved = await GRush.cloudSave.save({ stage: 3 }, "default", {
    baseRevision: revision,
    fallback: "local",
  });
  if (saved.ok) console.log(saved.value.storage);
}
```

- `fallback: "local"` を渡すと、GameRush がプレイヤーのサインインを確かめられないとき（渡さなければ `signInRequired` になるとき）だけ、セーブを端末に読み書きする。そのとき返る項目は `storage: "local"`、`revision: 0`。クラウドに置けたときは `storage: "cloud"`
- 端末のセーブはその端末のそのアプリ（ブラウザ）にだけあり、ブラウザが消すことがある。サインインしても自動ではクラウドへ上がらない。サインイン後の `load` でクラウドに無ければ端末のセーブが返るので、それを `save` するとクラウドへ上がる。`fallback: "local"` 付きの `save` / `remove` がクラウドで成功すると、同じスロットの、そのプレイヤーの端末のセーブと、どのアカウントのものか分からない端末のセーブが消える。別のアカウントのものは残る
- サインイン済みの `load` は、別のアカウントのものと分かっている端末のセーブを返さない。サインインを確かめられないときの `load` と `remove` は、どのアカウントで保存したかに関係なく、その端末のセーブを返し、消す。共用の端末では、前に使った人の端末のセーブが返ることがある
- サインインが戻るとクラウドのセーブが優先される。サインインを確かめられなかった間に端末へ保存した新しい分は、クラウドにセーブがあれば `load` で返らない。`fallback: "local"` 付きの保存がクラウドで成功すると、そのプレイヤーの端末のセーブは消える
- 端末への書き込みでは `baseRevision` を見ない。端末のセーブの `revision`（`0`）をそのまま `baseRevision` に渡すと、クラウドが空なら書け、クラウドにあれば `conflict` になる
- サインイン直後の `save` が `conflict` になったら、`load` してから書き直す
- `fallback` に `"local"` と `null` 以外を渡すと `invalidParams`。`null` は渡さないときと同じ。古い GameRush（`protocolVersion` 5 未満）では `fallback` を無視し、渡さないときと同じ呼び出しになる

### 相手探し

```js
await GRush.playerState.setMine({ deck: "fire", level: 12 }, undefined, { rating: 1520 });
const found = await GRush.playerState.sample({ count: 5, minRating: 1400, maxRating: 1600 });
if (found.ok) for (const rival of found.value) console.log(rival.pseudoId, rival.rating, rival.payload);
```

- `sample` は同じゲームの他プレイヤーの公開状態をランダムに返す（`count` は 1〜20、既定 10）。自分と運営が伏せた状態は返らず、名前も返らない
- `minRating` と `maxRating` は一緒に渡す。範囲を渡すと、`rating` の無い状態は返らない
- `setMine` の第3引数の `rating` は -1e9 より大きく 1e9 より小さい数値。`null` で消し、省略すると今の値のまま
- 古い GameRush（`protocolVersion` 7 未満）では `sample` が `unsupported`。`setMine` は `rating` を送らずに payload だけを書く

### 確認用の表示

```js
GRush.playerState.onPreview((state) => {
  showRival(state.payload, state.rating); // 他プレイヤーの状態を描くときと同じ見た目で描く
});
```

- GameRush の確認用の表示で、ある公開プレイヤー状態がほかのプレイヤーにどう見えるかを描くよう頼まれたときに `handler` を呼ぶ。渡るのは `{ pseudoId, payload, revision, rating, updatedAt }`。返り値は解除関数
- 同じ状態は1回だけ渡る。登録より先に届いていた状態は、登録したときに渡る。それより後に足した `handler` には渡らないので、起動したらすぐ登録する
- `handler` が例外を投げると、GameRush には描けなかったと伝わる
- ふだんのプレイでは呼ばれない。古い GameRush（`protocolVersion` 10 未満）と GameRush の外でも呼ばれず、例外も投げない
- `handler` はそれぞれ別の複製を受け取る。`GRush.configure({ backend })` でバックエンドを切り替えても、購読は新しいバックエンドへ移って続く
- モックでは `GRush.mock.previewPlayerState(pseudoId, payload, { revision, rating })` で渡せる（下の「ローカルでの動作確認」）

### 受信箱

```js
await GRush.inbox.send(rivalPseudoId, "battleResult", { stage: 3, win: true, score: 1200 });
const inbox = await GRush.inbox.list({ unreadOnly: true });
if (inbox.ok) {
  for (const message of inbox.value.messages) console.log(message.from, message.kind, message.payload);
  await GRush.inbox.markRead(inbox.value.messages.map((message) => message.id));
}
```

- 同じゲームの疑似 ID 宛てに、小さい構造化メッセージ（非同期対戦の結果の通知など）を送る。ゲストも送受信できる
- **payload で文章や画像は送れない。** payload はオブジェクトで、文字列の値とキーは識別子（`^[A-Za-z0-9_.:-]{1,32}$`）だけ、ほかは数値・真偽値・null。入れ子は最上位を 1 段目として 4 段まで、値は合計 64 個まで、詰めた JSON で 1KB まで。`kind` は `^[A-Za-z0-9._:-]{1,32}$`。合わなければ `invalidParams`
- 利用者どうしの文章や画像のやりとりには使わない
- `list` は新しい順（`limit` は 1〜50、既定 20）。続きは `nextCursor` を `cursor` に渡す。`unreadCount` は絞り込みによらない未読の数。`markRead` / `remove` は 1 回 50 件まで
- 同じゲームの疑似 ID でない宛先は `invalidParams`。送りすぎ（毎時・毎日の上限）は `rateLimited` で、時間が経てば回復する。待つ時間が分かれば `retryAfterMs` が入る
- `report(messageId)` は GameRush が確認を出し、承諾されたら `true`。通報すると送り手をブロックし、その相手のメッセージと出品は見えなくなる。ゲストは `signInRequired`
- 古い GameRush（`protocolVersion` 7 未満）では `unsupported`

### 交換所

```js
// 1. 出すアイテムをセーブで仮置きにし、2. operationId と一緒に保存してから出品する。
save.escrow = { operationId: crypto.randomUUID(), item: "sword" };
await GRush.cloudSave.save(save);
const created = await GRush.trade.create({
  offer: { item: "sword", count: 1 },
  want: { item: "gem", count: 3 },
  offerKey: "sword",
  wantKey: "gem",
  operationId: save.escrow.operationId,
});
// 3. 応答が失われたら、同じ operationId で呼び直す。

// 4. 終わった取引をセーブへ反映し、保存してから ack する。5. 取引 ID で二度反映しない。
const KNOWN_ACTIONS = ["receiveGive", "returnOffer", "receiveOffer"];
const mine = await GRush.trade.mine();
if (mine.ok) {
  const done = mine.value.pending.filter((trade) => KNOWN_ACTIONS.includes(trade.action));
  for (const trade of done) {
    if (save.appliedTrades.includes(trade.id)) continue;
    applyTrade(save, trade); // action ごとにアイテムを足す・戻す
    save.appliedTrades.push(trade.id);
  }
  const saved = await GRush.cloudSave.save(save);
  if (saved.ok && done.length) await GRush.trade.ack(done.map((trade) => trade.id));
}
```

- プレイヤーがアイテムを出品し、同じゲームの別のプレイヤーが `accept(tradeId, give)` で受ける。ゲストも出品・受諾できる。GameRush はアイテムの正当性を確かめず、交換が片方だけ成立しないことと、終わった取引を取りこぼさないことだけを保証する
- **取りこぼさない使い方**:
  1. 出品の前に、出すアイテムを手元のセーブで仮置き（使えない状態）にする
  2. `operationId`（`^[A-Za-z0-9._:-]{1,64}$`）をセーブに保存してから `create` する
  3. 応答が失われたら、同じ `operationId` で `create` を呼び直す。同じ `operationId` の再送は、中身によらず先に作った出品を返す
  4. `mine()` の `pending` をセーブに反映し、クラウドセーブに保存してから `ack` する
  5. 反映済みの取引 ID をセーブに持ち、同じ取引を二度反映しない
- `pending` の `action` は `receiveGive`（出品者が `give` を受け取る）・`returnOffer`（出品者が `offer` を戻す。取り下げ・期限切れ・運営の非表示）・`receiveOffer`（受けた側が `offer` を受け取る）。知らない値は反映せず、`ack` もしない
- **`offer`・`want`・`give` で文章や画像は送れない。** 形は受信箱の payload と同じで、大きさは詰めた JSON で offer 2KB・want 1KB・give 2KB まで。利用者どうしの文章や画像のやりとりには使わない
- `accept` は先に取られた・期限切れ・取り下げ・見えない出品をエラーにせず、`outcome`（`matched` / `taken` / `expired` / `cancelled` / `notFound`）で返す。`trade` は `matched` のときだけ入る。同じ取引への再送は `matched`
- `to` に疑似 ID を渡すと指名の出品になる。`expiresInSec` は 600〜604800（既定 3 日）。受付中の出品は 1 人 10 件まで
- 受付中の出品が 10 件あるときの `create` は `invalidParams` で、待っても直らない（取り下げるか、成立・期限切れを待つ）。毎日 30 件の出品と毎時 30 件の受諾の上限は `rateLimited` で、時間が経てば回復する。待つ時間が分かれば `retryAfterMs` が入る
- `list` は他人の公開の出品と自分宛ての指名の出品のうち、受付中のもの（新しい順）。`offerKey` / `wantKey` で絞る。`give` は当事者にだけ入る
- `report(tradeId)` は GameRush が確認を出し、承諾されたら `true`。通報すると出品者をブロックする。ゲストは `signInRequired`
- 古い GameRush（`protocolVersion` 7 未満）では `unsupported`

### 共有

```js
if (await GRush.share.isAvailable()) {
  const shared = await GRush.share.share({ text: "ステージ3をクリア", image: "screen" });
  if (shared.ok) console.log(shared.value.status);
}
```

- ゲームの呼び出しで共有が開くのではなく、GameRush の確認シートが出て、プレイヤーが送り先を押したときに開く。ゲームに返るのは `opened` / `cancelled` だけ
- `image` は `"screen"`（ゲームの canvas のスクショ）/ `Blob` / `ArrayBuffer` / 型付き配列 / data URL / `HTMLCanvasElement` / `{ base64, mimeType }`。4MB まで。**DOM で描いた文字は `"screen"` に写らない**
- 共有は 5 秒に 1 回まで。1 回のボタン操作で呼ぶのは 1 回にする。共有したことを条件に報酬を出さない
- 本文は 100 文字まで。URL と @メンションを含むと `invalidParams`。添付される URL は GameRush がゲームのページから作り、ゲームからは指定できない
- 古い GameRush（`protocolVersion` 3 未満）では `unsupported`

#### 起動パラメータを添える

```js
const shared = await GRush.share.share({ text: "ステージ3に挑戦", launchParams: { stage: "3" } });
if (!shared.ok && shared.code === "unsupported") await GRush.share.share({ text: "ステージ3に挑戦" });
```

- 添えた値は共有リンクに `?gp.stage=3` のように載り、リンクを開いた人のゲームの `GRush.launch` に渡る（下の「起動パラメータ」）
- キーと値の制限は「起動パラメータ」と同じ。1つでも合わなければ、共有を開かずに `invalidParams`。空のオブジェクトは渡さないときと同じ
- 古い GameRush（`protocolVersion` 9 未満）では、共有を開かずに `unsupported`。`launchParams` を外して呼び直せば共有できる
- **リンクは誰にでも見え、そのまま転送される。** プレイヤーを識別できる値（招待コードなど）を入れない。受け取る側のゲームは値を信用せず、確かめてから使う

### 表示言語

```js
const stop = GRush.locale.onChange((next) => console.log(next.locale));
const language = await GRush.locale.get();
if (language.ok) console.log(language.value.locale, language.value.source);
```

- `locale` は BCP 47 の言語タグ（例 `"ja"` / `"en-US"`）。`source` は `"user"`（GameRush の言語設定）/ `"system"` / `"device"`（端末の言語）で、今後増えても動くように書く。`languages` は優先順の一覧
- `source` は必ず入り、GameRush が渡さなければ `"device"`。`languages` は空にならず、GameRush が空の一覧を渡せば `[locale]`
- 返る配列は複製。`onChange` の `handler` もそれぞれ別の複製を受け取る。書き換えても GameRush 側には影響しない
- 古い GameRush（`protocolVersion` 4 未満）では `get()` が `unsupported`、`current()` が `null`、`onChange` の `handler` は呼ばれない
- `GRush.configure({ backend })` でバックエンドを切り替えても、`onChange` の購読は新しいバックエンドへ移って続く
- モックは `GRush.mock.config.locale`（既定 `null` = ブラウザの言語、`source: "device"`）で切り替える。`onChange` は呼ばれない

### 起動パラメータ

GameRush の URL に `gp.` を付けて載せたキーと値を読む。ゲームのページの URL が `/g/<コード>?gp.item=sword&gp.stage=3` なら `{ item: "sword", stage: "3" }`。シェアしたリンクから特定のアイテムやステージへ飛ばすのに使う。

```js
const launched = await GRush.launch.get();
const item = launched.ok ? launched.value.params.item : undefined;
if (item && ownsItem(item)) openItem(item);
```

- **値を信用しない。** リンクは誰でも作れる。アイテムが存在するか・プレイヤーが持っているか・ステージが解放済みかをゲームの側で確かめ、確かめられなければ無視する
- キーは英数字と `_-` で 32 文字まで（`__proto__` は使えない）、値は英数字と `._~:,-` で 128 文字まで（空も可）、8 個まで。形の合わない項目と、2回書かれたキーは GameRush が落とし、8 個を超えたら全部落とす
- 渡るのは、プレイヤーが最初に開いたスライドのゲームだけ。別のゲームへスワイプして戻ったときは `params` が空。フィードではページを読み直すと空になるが、単体表示や埋め込みでは読み直すと同じ値がまた渡ることがあるので、何度渡っても困らないように書く
- `get()` は GameRush から届くまで待つ。`current()` は届く前なら `null`
- 古い GameRush（`protocolVersion` 8 未満）と GameRush の外では `get()` が `unsupported`、`current()` が `null`。GameRush のアプリ側が古くて答えられないときは、`unsupported` ではなく空の `params` が返る
- モックは `GRush.mock.config.launchParams`（既定 `{}`）をそのまま返す。上の制限では確かめない

### アナリティクス

```js
GRush.analytics.logOnboardingStep(1, "tutorial_start");
GRush.analytics.logFunnelStep("shop", "visit-1", 2, "item_selected", { fields: { tab: "weapons" } });
GRush.analytics.logCustomEvent("boss_defeated", 1, { fields: { stage: "3" } });
GRush.analytics.logEconomyEvent("sink", "coin", 50, 120, "Shop", { itemSku: "sword" });
```

作者のアナリティクスへ、オンボーディングとファネルのステップ・カスタムイベント・通貨の入手と消費を送る。

- **ほかの API と違い、どれも同期で `true` / `false` を返し、例外を投げない。** 待たずにどこからでも呼べる。`true` は GameRush へ渡したことで、保存されたことではない
- 形が不正なとき（下の制限）は `false` を返し、理由ごとに1回だけコンソールに警告が出る。古い GameRush（`protocolVersion` 6 未満）と GameRush の外では `false`
- `step` は 1〜100 の整数。`value` は省略で 1、絶対値 1e9 まで。`amount` は正の値で 1e12 まで、`endingBalance`（その後の残高）は必須で絶対値 1e15 まで
- `flowType` は `"source"`（入手）か `"sink"`（消費）。`transactionType` の標準の値は `"TimedReward"` / `"Onboarding"` / `"Shop"` / `"Gameplay"` / `"ContextualPurchase"` で、ほかの値も受ける
- イベント名・ファネル名・`funnelSessionId` は英数字と `._:-` で 64 文字まで、通貨と `transactionType` は 32 文字まで
- `stepName`・`itemSku`・`fields` の値は1行のテキストに直してから受ける。改行・制御文字・双方向の上書きと isolate は空白に直し、前後の空白を落としてから 40 文字（コードポイント）まで数える。直した結果が空（空白や見えない文字だけ）の `stepName` と `itemSku` は省略と同じに扱い、`fields` の値は拒む。`fields` は3つまで、キーは英数字と `_` で 32 文字まで
- オンボーディングとファネルの同じステップは、1セッションで最初の1回だけが残る。セッションはページを読み直しても続く。同じファネルを何度も通るなら、通るたびに別の `funnelSessionId` を渡す
- 名前・値・`fields` に、プレイヤーを識別できる情報を入れない
- GameRush の中でも、ゲームが前面に出るまでの分は溜めてから送る。溜められるのは 30 件までで、超えた分は `false`
- `true` を返しても、次の分は保存されない
  - 前面に出た後に GameRush 本体が掛ける上限を超えた分。本体は 500ms に1件、まとめて最大 30 件まで受け、送る前の列は合計 200 件まで
  - セッションあたりの保存の上限を超えた分。オンボーディングを含むファネルのステップ 200 件・カスタムイベント 500 件・エコノミー 500 件
  - 送れなかった分（送り直さない）

### 対戦

```js
const joined = await GRush.net.join({ mode: "duel" });
if (joined.ok) {
  const room = joined.value;
  room.on("message", (message) => {
    if (message.isStale) return;
    console.log(message.from, message.json());
  });
  room.on("peerjoin", (peer) => console.log("joined", peer.index));
  room.on("error", ({ code, message }) => console.warn("dropped", code, message));
  room.on("close", ({ reason }) => console.log("closed", reason));
  room.sendJson({ x: 1, y: 2 }, { channel: GRush.CHANNEL_UNRELIABLE });
}
```

- 送れるのは `ArrayBuffer` / 型付き配列 / 文字列（`sendJson` は JSON 文字列）。1 通 8KB まで
- `channel: "unreliable"` は落ちる・順序が入れ替わる前提で書く。いまの中継では落ちないが、WebRTC へ切り替わった時点で落ち始める
- `to` に peer の `index` を渡すとその相手だけへ送る。省略すると全員
- `join` をもう一度呼ぶと、前の部屋は `close`（reason `"replaced"`）になる
- 部屋が1通を捨てると `error` が届く。`code` は `"messageTooLarge"`・`"rateLimited"`・`"badFrame"` で、ほかの値が届くこともある。部屋はつながったままで、続けて送れる。部屋が閉じるときは `close` だけが届く
- 部屋のプロパティ: `peers` / `localPeerId` / `hostPeerId` / `isHost()` / `transport` / `serverTimeMs()` / `lastSeqFrom(peerId)` / `isClosed`

## ローカルでの動作確認

`localhost`・`127.0.0.1`・`file://` では `GRush.backend` が `"mock"` になる（ESM 版は `file://` だとブラウザが読み込みを拒むので、ローカルサーバから開く）。GameRush 上では `"web"`、それ以外のサイトでは `"none"`。`GRush.configure({ backend: "mock" })` で強制もできる。

```js
if (GRush.backend === "mock") {
  GRush.mock.defineLeaderboard("score", { sort: "desc", minValue: 0, maxValue: 100000 });
  GRush.mock.addRival("score", "Rival", 900);
  GRush.mock.config.signedIn = true;
  GRush.mock.config.grantProfileConsent = false;
  GRush.mock.config.unreliableDropRate = 0.1;
  GRush.mock.config.shareStatus = "cancelled";

  const bot = GRush.mock.addPeer("Sparring Partner");
  bot.on("message", (message) => bot.send(message.payload));
}
```

`GRush.mock.raiseRoomError(code, message)` は、自分がいる部屋に `error` を届ける（本番と同じく非同期で、部屋は閉じない）。部屋にいなければ `false` を返す。

モックは実サーバと同じ縛り（宣言していない key への投稿・値域外・int の枠への小数・公開プレイヤー状態の 4KB と base64 らしい文字列・ゲストのクラウドセーブと通報・部屋コードの形式）で弾く。有効プレイ 10 秒未満の投稿と投稿頻度の上限は再現しない。`signedIn: false` のとき `fallback: "local"` 付きのクラウドセーブは、モックの中の端末の保存先に読み書きし（`reset()` で消える）、`signedIn` を `true` に戻すとクラウドへ書けるようになる。共有は確認シートを出さず、`shareStatus`（既定 `"opened"`）をそのまま返す。`launchParams` は GameRush と同じ制限で確かめ、合わなければ `invalidParams`。本文と画像の検査はしないので、弾かれる本文は GameRush 上で確かめる。

アナリティクスのモックは、GameRush と同じ検査をして、通ったイベントを1件ずつコンソールに出し、直近の 200 件を `GRush.mock.analyticsEvents()` で返す（`reset()` で空になる）。弾いたイベントは、GameRush と同じく理由ごとに1回だけコンソールに警告する（`reset()` でまた出る）。どこへも送らない。前面に出るまでの 30 件の溜め・本体の上限・同じステップを最初の1回だけ残す扱い・セッションあたりの上限は再現しないので、モックでは `true` の分がすべて記録に残る。モックが名乗る `protocolVersion` は 10。

相手探し・受信箱・交換所のモックは、`GRush.mock.rivals` の 3 人の相手を持つ。相手はそれぞれ rating 付きの公開プレイヤー状態を持ち、届いたメッセージを同じ `kind` と `payload` で送り返す。はじめと `reset()` の後は、最初の相手からのメッセージ1通と、相手の受付中の出品を2件持つ。payload・offer・want・give の形、`operationId` での冪等、受付中の出品の上限、受諾の `outcome`、`pending` と `ack` は GameRush と同じ規則で動く。通報を承諾すると（`confirmInboxReport` / `confirmTradeReport`、既定 `true`）相手をブロックし、その相手のメッセージと出品は見えなくなる。

```js
const [rival] = GRush.mock.rivals;
GRush.mock.receiveInbox(rival, "battleResult", { stage: 3, win: false });
const listing = GRush.mock.offerTrade(rival, { item: "bow" }, { item: "gem" }, { toSelf: true });
const created = await GRush.trade.create({ offer: { item: "sword" }, want: { item: "gem" }, operationId: "op-1" });
GRush.mock.acceptTrade(created.value.id, { item: "gem" }); // 相手が受けて、自分の pending に receiveGive が載る
GRush.mock.expireTrade(listing.id);
GRush.mock.definePlayerState("custom-rival", { level: 3 }, { rating: 1300 });
GRush.mock.previewPlayerState("custom-rival", { level: 3 }, { rating: 1300 });
```

`GRush.mock.previewPlayerState(pseudoId, payload, { revision, rating })` は、`GRush.playerState.onPreview` の `handler` に確認用の表示の状態を渡す。渡すのは呼び出しの後（非同期）で、`handler` が無ければ次に登録したときに渡す。`revision` は省略すると 1、`rating` は省略すると `null`。形が合わなければ何もせず `false` を返す。

**`unreliableDropRate` は既定 0 だが、出荷前に必ず 0 より大きくして試すこと。** パケットが落ちる前提で書けているかを確かめられる場所はここだけになる。

### grush.json をモックで使う

ランキングの定義をビルドの最上位（`index.html` の隣）の `grush.json` に書いておくと、モックは最初のランキングの呼び出しの前にページと同じフォルダの `grush.json` を読み、その枠を宣言する。アップロードと手元の確認で同じファイルを使える。書式は [SDK ガイドのランキング](https://gamerush.jp/sdk#leaderboards)。

- 読むのは `http://localhost` などのローカルサーバから開いたときだけ。`file://` では読まないので、`GRush.mock.loadLeaderboards(manifest)` に中身（オブジェクトか JSON の文字列）を渡す
- ファイルが無いときと、3 秒以内に読めないときは何もしない。書式の誤りはアップロードと同じ文言でコンソールに警告し、その中身は使わない。`loadLeaderboards` は誤りを `invalidParams` で返す
- 自動で読むときは、同じ key を `defineLeaderboard` で宣言してあればそちらを使う。`loadLeaderboards` に渡した定義は、`defineLeaderboard` の宣言を置き換える。`loadLeaderboards` を呼んだら、自動では読まない
- 先に `addRival` で足した相手は、`grush.json` の定義の枠へ引き継ぐ
- `enabled: false` の枠は一覧に出ず、投稿と取得は宣言していない key と同じく `invalidParams` になる。grush.json で `minValue` / `maxValue` を書かなかった枠は、GameRush と同じく投稿を受けない
- `period` が `daily` / `weekly` / `monthly` の枠は、GameRush と同じ期間キー（UTC）を返し、期間が変わると空からやり直す
- `reset()` の後は、次のランキングの呼び出しで `grush.json` を読み直す

## サンプル

| サンプル | 内容 |
|---|---|
| [`examples/score-attack/`](examples/score-attack/index.html) | 10 秒タップ。ランキングへの投稿と上位表示。このリポジトリの直下で `npx serve` などを起動し、`http://localhost:3000/examples/score-attack/` を開くとモックで動く |

## 開発

`src/` が正で、`grush-sdk.js` / `grush-sdk.mjs` はそこからの生成物（コミットしてある）。`src/` を直したら生成し直してコミットする。

```bash
npm install
npm run build
npm test
```

`npm test` は生成物が `src/` と食い違っていると失敗する。

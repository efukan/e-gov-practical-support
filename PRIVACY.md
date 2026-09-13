# Privacy Policy for e-Gov Law Search Himotoki (e-Gov法令検索ひもとき)

*Last Updated: September 13, 2026 / 最終更新日: 2026年9月13日*

English version follows the Japanese version. (日本語版の後に英語版が続きます)

---

## 日本語版 (Japanese)

本プライバシーポリシーは、「e-Gov法令検索ひもとき」（以下「本拡張機能」）におけるユーザー情報の取り扱いについて説明するものです。

### 1. 個人情報の収集および送信について
本拡張機能は、ユーザーの個人情報、閲覧履歴、入力内容、その他いかなる個人を特定可能なデータも収集・蓄積しません。当開発元のサーバーへ送信されるデータもありません。
本拡張機能の各機能は、後述の「被引用（引用元）表示」を除き、すべて利用者の端末（ブラウザ環境）内で実行されます。

### 2. 使用する権限およびデータ同期について
本拡張機能は以下の権限およびAPIを使用します。これらはすべて本拡張機能の機能提供のみを目的としており、その他の目的には使用されません。

*   **`storage` (chrome.storage.sync)**
    *   **目的**: ユーザーが設定画面（オプションページ）やポップアップで切り替えた各機能のON/OFF状態（例：横書き変換の有効化、括弧薄字化の有効化など）を保持および同期するため。
    *   **同期の仕組み**: 設定データはブラウザ公式の同期ストレージ機能（`chrome.storage.sync`）を通じて、利用者がログインしているブラウザ提供会社（Google社等）の安全なインフラを介して他の端末へ同期されます。同期されるのは機能のオン／オフ等の設定情報のみであり、閲覧した法令テキストや個人情報が含まれることはありません。当開発元を含む第三者がこれにアクセス・収集することはありません。ブラウザの同期機能をオフにしている場合は、端末内にのみ保存されます。

### 3. 法令データの処理および外部通信について
本拡張機能は、ユーザーが閲覧している e-Gov 法令検索（`laws.e-gov.go.jp` および `elaws.e-gov.go.jp`）のウェブページ上で動作します。

*   **端末内での処理**:
    表示されている法令文書のテキスト解析（漢数字の算用数字への変換、括弧書きの薄字化、定義語の抽出、参照条文ポップアップ、目次ハイライト、条文ジャンプ検索など）はすべてローカル（利用者の端末内）で実行されます。閲覧した法令の内容や入力テキストが、当開発元を含む第三者のサーバーへ送信・保存されることはありません。
*   **外部への通信（被引用表示機能）**:
    「被引用（引用元）表示」機能のみ、その条文を引用している他法令の一覧を取得するため、利用者が閲覧中の e-Gov 法令検索（`laws.e-gov.go.jp`）内部APIへ直接問い合わせを行います。送信するのは表示中の法令を特定する識別子（法令ID）と条文の位置情報（条文ID）のみであり、利用者を識別する情報や閲覧履歴等は含まれません。この通信は利用者が閲覧しているサイトとの間で完結し、当開発元がその内容を受信・記録することはありません。本機能は設定画面またはポップアップからいつでもオフにできます。

### 4. お問い合わせ
本プライバシーポリシーまたは本拡張機能に関するご質問は、ウェブサイト（https://efukan.jp ）または GitHub リポジトリの Issue 等を通じてご連絡ください。

---

## English Version (English)

This privacy policy explains how "e-Gov Law Search Himotoki" (hereinafter "the Extension") handles user information.

### 1. Collection and Transmission of Personal Information
The Extension does not collect, store, or transmit any personal information, browsing history, inputs, or other identifiable data. No data is transmitted to the developer's server.
All operations of the Extension are performed entirely within your local browser environment, with the sole exception of the "Cited-by (Citations) Display" feature described below.

### 2. Permissions Used and Data Synchronization
The Extension uses the following permissions and APIs. These are used solely to provide the Extension's features and not for any other purposes:

*   **`storage` (chrome.storage.sync)**
    *   **Purpose**: To save and synchronize user preferences and feature ON/OFF toggles (e.g., enabling horizontal conversion, parenthesis dimming) set on the options or popup pages.
    *   **Sync Mechanism**: Settings data is synchronized using the browser's official sync storage (`chrome.storage.sync`) via Google's secure infrastructure across devices logged into the same account. Only functional preference toggles are synchronized; no legal document text or personal data is included. No third party, including the developer, has access to or collects this data. If browser synchronization is disabled, settings are stored locally on the device only.

### 3. Processing of Legal Document Data and Network Requests
The Extension operates on the official e-Gov Law Search webpages (`laws.e-gov.go.jp` and `elaws.e-gov.go.jp`).

*   **Local Processing**:
    Text analysis of displayed legal documents (such as converting kanji numbers to Arabic digits, dimming parentheses, extracting definitions, reference popups, table of contents highlighting, and article jump search) is executed entirely locally within the user's browser. Browsed legal text and input queries are never uploaded or saved to any server.
*   **Network Communication (Cited-by Display)**:
    Only the "Cited-by (Citations) Display" feature queries the internal API of e-Gov Law Search (`laws.e-gov.go.jp`) directly from the user's browser to fetch the list of other laws citing that specific article. The request transmits only the document identifier (Law ID) and article position identifier (Article ID) of the currently viewed page. It contains no personally identifiable information or browsing history. This communication is conducted directly between the user's device and the e-Gov website; the developer never receives or logs this transmission. This feature can be turned off at any time via the options or popup menu.

### 4. Contact
For any questions regarding this privacy policy or the Extension, please reach out via our website (https://efukan.jp ) or GitHub Issues.

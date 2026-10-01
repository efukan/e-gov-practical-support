# Privacy Policy for e-Gov Law Himotoki (e-Gov法令ひもとき)

*Last Updated: October 1, 2026 / 最終更新日: 2026年10月1日*

English version follows the Japanese version. (日本語版の後に英語版が続きます)

---

## 日本語版 (Japanese)

本プライバシーポリシーは、「e-Gov法令ひもとき」（以下「本拡張機能」）におけるユーザー情報の取り扱いについて説明するものです。

### 1. 個人情報の収集および送信について
本拡張機能は、ユーザーの個人情報、閲覧履歴、入力内容、その他いかなる個人を特定可能なデータも収集・蓄積しません。当開発元のサーバーへ送信されるデータも一切ありません。
本拡張機能の各機能は、後述の「e-Gov 法令検索の公式APIとの通信」を除き、すべて利用者の端末（ブラウザ環境）内で完結して実行されます。

### 2. 使用する権限およびデータ同期について
本拡張機能は以下の権限およびAPIを使用します。これらはすべて本拡張機能の機能提供のみを目的としており、その他の目的には使用されません。

*   **`storage` (chrome.storage.sync)**
    *   **目的**: ユーザーが設定画面（オプションページ）やポップアップで切り替えた各機能のON/OFF状態（例：横書き変換の有効化、括弧薄字化の有効化、定義語カラー設定など）を保持および同期するため。
    *   **お気に入り**: 利用者が「☆ お気に入り追加」で登録した法令の一覧（法令ID・法令名・法令番号・登録日時）も、複数の端末で同じ一覧を使えるよう、ここに保存します。一覧はポップアップの ☆ で外すと消えます。
    *   **同期の仕組み**: 設定データとお気に入りは、ブラウザ公式の同期ストレージ機能（`chrome.storage.sync`）を通じて、利用者がログインしているブラウザ提供会社（Google社等）の安全なインフラを介して他の端末へ同期されます。同期されるのは機能のオン／オフ等の設定情報と、利用者が自分で登録したお気に入りの法令（公開されている法令のIDと名前）のみであり、閲覧履歴や閲覧した法令テキスト、個人情報が含まれることはありません。当開発元を含む第三者がこれにアクセス・収集することはありません。ブラウザの同期機能をオフにしている場合は、端末内にのみ保存されます。
*   **`storage` (chrome.storage.local)**
    *   **目的**: 施行令・施行規則などの政令・省令を表示したときに、親の法律の定義語を示すため、e-Gov 法令検索の公式API から取得した親の法律の条文から抜き出した定義語（語・条項番号・定義文）を、次回の表示で再取得しないよう保存します。
    *   **保存の範囲**: 保存されるのは公開されている法令の条文の一部のみで、閲覧履歴や個人情報は含まれません。利用者の端末内にのみ保存され（同期されません）、7日を過ぎたものは使われず、保存する法令は最大20件です。設定の「親の法律の定義語も表示」をオフにすると取得・保存を行いません。
    *   **検索の履歴**: ポップアップの法令名検索で使った語（最大10件）を、次回に選び直せるよう保存します。利用者の端末内にのみ保存され（同期されません）、外部へ送信されることはありません。履歴の右のゴミ箱で1件ずつ消せ、拡張機能を削除するとすべて消えます。

### 3. 法令データの処理および外部通信について
本拡張機能は、ユーザーが閲覧している e-Gov 法令検索（`laws.e-gov.go.jp`）のウェブページ上で動作します。

*   **端末内での処理**:
    表示されている法令文書のテキスト解析（漢数字の算用数字への変換、括弧書きの薄字化、接続詞の色分け、定義語の抽出・ハイライト、同一法令内の条文プレビュー生成、目次ハイライト、条文ジャンプ検索など）はすべてローカル（利用者の端末内）で実行されます。閲覧した法令の内容や入力テキストが、当開発元を含む第三者のサーバーへ送信・保存されることはありません。
*   **外部への通信（被引用一覧および条文プレビュー取得）**:
    「被引用（引用元）表示」機能（引用元法令一覧および該当条文本文の取得）、「他法令リンクのプレビュー表示」機能（条文本文中の他法令リンクホバー時にその条文本文を取得）、ならびに政令・省令を表示したときの「親の法律の定義語」機能（親の法律の条文を取得して定義語を抜き出す）においてのみ、公の条文データをオンデマンドで取得するため、利用者が閲覧中の e-Gov 法令検索公式サーバー（`laws.e-gov.go.jp` の内部APIおよび公式XML API）へ直接問い合わせを行います。
    送信するのは取得対象の法令を特定する識別子（法令ID）や条文番号（条文ID）のみであり、利用者を識別する個人情報や閲覧履歴等は一切含まれません。
    この通信は利用者の端末と公式e-Govサーバーとの間で直接完結し、当開発元がその通信内容を受信・記録・中継することは一切ありません。なお、これらの機能は設定画面またはポップアップからいつでも個別にオフにできます。
*   **外部への通信（ポップアップの法令名検索）**:
    ポップアップの検索欄に法令名や略称を入力したときだけ、法令を探すために、入力した語を e-Gov 法令検索の公式API（`https://laws.e-gov.go.jp/api/2/laws`）へ送信します。送信するのは入力した検索語のみで、利用者を識別する情報や閲覧履歴は含まれません。通信は利用者の端末と公式e-Govサーバーとの間で直接行われ、当開発元が受信・記録・中継することはありません。検索欄に入力しなければ通信は行いません。

### 4. お問い合わせ
本プライバシーポリシーまたは本拡張機能に関するご質問は、ウェブサイト（https://efukan.jp ）または GitHub リポジトリの Issue 等を通じてご連絡ください。

---

## English Version (English)

This privacy policy explains how "e-Gov Law Himotoki" (hereinafter "the Extension") handles user information.

### 1. Collection and Transmission of Personal Information
The Extension does not collect, store, or transmit any personal information, browsing history, user inputs, or other identifiable data. No data is transmitted to the developer's server.
All operations of the Extension are performed entirely within your local browser environment, with the sole exception of the communication with the official e-Gov Law Search API described below.

### 2. Permissions Used and Data Synchronization
The Extension uses the following permissions and APIs. These are used solely to provide the Extension's features and not for any other purposes:

*   **`storage` (chrome.storage.sync)**
    *   **Purpose**: To save and synchronize user preferences and feature ON/OFF toggles (e.g., enabling horizontal conversion, parenthesis dimming, conjunction highlighting, definition color settings) set on the options or popup pages.
    *   **Favorites**: The list of statutes the user has saved with the "☆ お気に入り追加" (Add to favorites) button (Law ID, title, law number and the time it was added) is also stored here so that the same list is available on the user's other devices. Entries are removed with the ☆ button in the popup.
    *   **Sync Mechanism**: Settings data and favorites are synchronized using the browser's official sync storage (`chrome.storage.sync`) via Google's secure infrastructure across devices logged into the same account. Only functional preference toggles and the favorites the user has saved (IDs and titles of publicly available statutes) are synchronized; no browsing history, legal document text or personal data is included. No third party, including the developer, has access to or collects this data. If browser synchronization is disabled, this data is stored locally on the device only.
*   **`storage` (chrome.storage.local)**
    *   **Purpose**: When a cabinet order or ministerial ordinance (e.g., an enforcement order) is displayed, the Extension shows the terms defined in its parent Act. To avoid re-downloading, the defined terms extracted from the parent Act (term, article number and defining sentence), fetched from the official e-Gov API, are cached.
    *   **Scope**: Only excerpts of publicly available statutes are cached; no browsing history or personal data is included. The cache stays on the user's device only (not synchronized), entries older than 7 days are not used, and at most 20 statutes are kept. Turning off the "parent Act definitions" setting disables fetching and caching.
    *   **Search History**: The keywords used in the popup's law title search (up to 10) are stored so they can be selected again. They stay on the user's device only (not synchronized) and are never transmitted. Each entry can be deleted with the trash icon next to it, and all entries are deleted when the Extension is uninstalled.

### 3. Processing of Legal Document Data and Network Requests
The Extension operates on the official e-Gov Law Search webpages (`laws.e-gov.go.jp`).

*   **Local Processing**:
    Text analysis and layout enhancements of displayed legal documents (such as converting kanji numbers to Arabic digits, dimming parentheses, conjunction syntax highlighting, extracting definitions, table of contents highlighting, article jump search, and previewing articles within the same statute) are executed entirely locally within the user's browser. Browsed legal text and input queries are never uploaded or saved to any server.
*   **Network Communication (Citing Law Lists & Article Previews)**:
    Only when using the "Cited-by (Citations) Display" feature (to fetch the list of citing laws and their article texts) the "Referenced Law Preview" feature (to fetch article texts when hovering over links to other statutes), and the "Parent Act Definitions" feature (to fetch the parent Act of a displayed cabinet order or ministerial ordinance and extract its defined terms) does the Extension query the official e-Gov Law Search servers (`laws.e-gov.go.jp` internal API and public XML API) directly from the user's browser to retrieve public statutory texts on demand.
    These requests transmit only the document identifier (Law ID) and article position identifier (Article ID) necessary to fetch public statutory texts. They contain no personally identifiable information, user credentials, or browsing history.
    This communication is conducted directly between the user's device and the official e-Gov website; the developer never receives, relays, or logs this transmission. Each of these features can be disabled individually at any time via the options or popup menu.
*   **Network Communication (Law Title Search in the Popup)**:
    Only when the user types a law title or abbreviation into the search box in the popup, the typed keyword is sent to the official e-Gov Law Search API (`https://laws.e-gov.go.jp/api/2/laws`) to find matching statutes. Only the search keyword is sent; no identifying information or browsing history is included. The request goes directly from the user's device to the official e-Gov server; the developer never receives, relays, or logs it. No request is made unless the user types into the search box.

### 4. Contact
For any questions regarding this privacy policy or the Extension, please reach out via our website (https://efukan.jp ) or GitHub Issues.


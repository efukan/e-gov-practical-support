# Privacy Policy for e-Gov Law Search Practical Support (e-Gov 法令検索 実務サポート)

*Last Updated: June 23, 2026 / 最終更新日: 2026年6月23日*

English version follows the Japanese version. (日本語版の後に英語版が続きます)

---

## 日本語版 (Japanese)

本プライバシーポリシーは、「e-Gov 法令検索 実務サポート」（以下「本拡張機能」）におけるユーザー情報の取り扱いについて説明するものです。

### 1. 個人情報の収集および送信について
本拡張機能は、ユーザーの個人情報、閲覧履歴、入力内容、その他いかなるデータも収集しません。また、外部のサーバーへの送信や収集も一切行いません。本拡張機能の動作はすべてユーザーのローカルブラウザ内で完結します。

### 2. 使用する権限およびデータ同期について
本拡張機能は以下の権限およびAPIを使用します。これらはすべて本拡張機能の機能提供のみを目的としており、その他の目的には使用されません。

*   **`storage` (chrome.storage.sync)**
    *   **目的**: ユーザーが設定画面（オプションページ）で切り替えた各機能のON/OFF状態（例：横書き変換の有効化、括弧薄字化の有効化など）を保持および同期するため。
    *   **同期の仕組み**: 設定データは Google アカウントの同期機能（`chrome.storage.sync`）を利用して同期されるため、データは Google の安全なインフラを介してのみ処理され、開発者を含む第三者がこれにアクセスすることはありません。

### 3. 法令データの処理について
本拡張機能は、ユーザーが閲覧している e-Gov 法令検索（`laws.e-gov.go.jp` および `elaws.e-gov.go.jp`）のウェブページ上で動作します。表示されている法令文書のテキスト解析（漢数字の算用数字への変換、定義語の抽出、ポップアップの表示など）はすべてローカル（ユーザーの端末上）で実行され、外部へのデータのアップロード等は行われません。

### 4. お問い合わせ
本プライバシーポリシーまたは本拡張機能に関するご質問は、開発者のGitHubリポジトリのIssue等を通じてご連絡ください。

---

## English Version (English)

This privacy policy explains how "e-Gov Law Search Practical Support" (hereinafter "the Extension") handles user information.

### 1. Collection and Transmission of Personal Information
The Extension does not collect, track, or transmit any user personal information, browsing history, inputs, or other data. All operations of the Extension are performed entirely within your local browser. No data is sent to external servers.

### 2. Permissions Used and Data Synchronization
The Extension uses the following permissions and APIs. These are used solely to provide the Extension's features and not for any other purposes:

*   **`storage` (chrome.storage.sync)**
    *   **Purpose**: To save and synchronize the user's preferences and feature ON/OFF settings (e.g., enabling horizontal conversion, enabling parenthesis dimming) set on the options page.
    *   **Sync Mechanism**: Settings data is synchronized using Google's account sync feature (`chrome.storage.sync`). The data is processed only through Google's secure infrastructure, and no third party, including the developer, has access to it.

### 3. Processing of Legal Document Data
The Extension operates on the official e-Gov Law Search webpages (`laws.e-gov.go.jp` and `elaws.e-gov.go.jp`). The text analysis of the displayed legal documents (such as converting kanji numbers to Arabic digits, extracting definitions, and displaying popups) is processed locally on the user's device. No data is uploaded externally.

### 4. Contact
For any questions regarding this privacy policy or the Extension, please reach out via GitHub Issues of the repository.

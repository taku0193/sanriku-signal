# 岩手県山田町の観光・くらしRAG

岩手県山田町の観光、交通、くらしを出典付きで案内する学習用の試作です。基本資料には町や施設、地域団体・事業者の公開情報の要約を収録しています。町と観光協会の記事を取り込むと、手続き、子育て、防災、歴史、名所、宿泊、特産品なども検索できます。

検索、聞き返し、回答の構成は [ReActの設計](docs/agentic-rag-design.md) に、根拠と評価例は [設計調査ノート](docs/agentic-rag-research.md) にまとめています。

## ブラウザーで使う

入口でニックネームを入力し、「案内へ進む」を押すとチャット画面が開きます。名前は画面表示用としてブラウザーのタブ内に保存します。「案内の入口へ戻る」から呼び名を変更できます。

手元に保存した `yamada-guide.html` をブラウザーで開きます。サーバーの起動は不要です。質問を入力するか、観光・くらしの質問例を選ぶと、資料の要約と出典リンクが表示されます。「質問と資料をコピー」で、質問と根拠をまとめてチャットに渡せます。資料を更新した後は `python3 -B export_html.py` でHTMLを作り直せます。

単体HTMLには基本資料を収録しています。町や観光協会の公開記事も利用するには、下の手順で資料を取り込み、サーバー版を起動します。資料検索だけなら `python3 -B yamada_web.py`、AIの回答も使うなら `python3 -B yamada_web.py --model` を実行します。

Gemma 4 12Bで自動回答を使う場合は、下の手順3でOllamaを用意します。その後、ブラウザーと同じ端末で `python3 -B yamada_web.py --model` を実行し、[http://127.0.0.1:8765](http://127.0.0.1:8765/) を開きます。AIとの接続に失敗した場合は、同じ画面に資料検索の結果を表示します。停止するときはターミナルで `Ctrl+C` を押します。

AI回答モードでは検索や確認の進み具合が会話欄に表示されます。「鯨と海の科学館の入館料は？」に続けて「そこは何時まで？」と質問できます。根拠を確認するには回答の下にある「出典」を開きます。会話の文脈は開いているページ内で使い、「新しい会話」でリセットします。

「うちの地区の次の燃やせるごみの日は？」と質問し、地区名を聞かれたら「大沢です」と入力します。回答に、収集予定の日付と曜日が表示されます。「大沢の2026年12月のプラスチック収集日」のように期間と種類を指定することもできます。

## 1. まず資料を検索する

ターミナルでこのフォルダを開き、次のコマンドを1行ずつ実行します。Python 3の標準ライブラリだけで動きます。

```bash
python3 yamada_rag.py '鯨と海の科学館と道の駅やまだは、通常どちらが遅く閉まりますか？'
python3 yamada_rag.py 'ペットボトルのふたとラベルはどう出しますか？'
python3 yamada_rag.py '織笠駅に駐車場はありますか？'
```

最初の質問では両施設の開館時間、2問目では町の分別資料、3問目では三陸鉄道の駅情報が表示されます。出典を開いて、検索結果の内容と見比べてみてください。

## 2. 検索結果から回答を作る

`--prompt` を付けると、検索結果と、資料に基づいて出典付きで回答するための指示が一緒に表示されます。その出力をチャットに貼って試せます。

```bash
python3 yamada_rag.py --prompt '鯨と海の科学館と道の駅やまだは、通常どちらが遅く閉まりますか？'
```

この例では、科学館の通常の閉館は17:00、道の駅は18:00なので、道の駅のほうが1時間遅く閉まると答えられます。両施設のURLが回答に付いているかも確認します。

## 3. ReActでAIに検索や聞き返しを任せる

対応版のOllamaを起動します。Linuxでまだ起動していない場合は、別のターミナルで `ollama serve` を実行します。モデルの取得は初回だけで、ダウンロードは約8 GBです。この試作はOllama 0.40.16で動作を確認しています。 [Ollamaのダウンロード](https://ollama.com/download) · [Gemma 4 12B](https://ollama.com/library/gemma4:12b)

```bash
ollama pull gemma4:12b
python3 yamada_rag.py --model --trace '岩手船越駅が最寄りの施設とおいすたは、通常どちらが遅く閉まりますか？'
python3 yamada_rag.py --model --trace --baseline '岩手船越駅が最寄りの施設とおいすたは、通常どちらが遅く閉まりますか？'
```

`--model` ではローカルのGemma 4 12Bが最初の行動を選びます。`--trace` を付けると、選んだ行動、検索語や地区・年度、取得した出典IDが表示されます。1回の入力につき検索は最大2回、行動判断は最大3回です。`--baseline` では、Pythonが質問文で1回検索し、その結果からAIが回答します。

## 4. 回答と出典をまとめて評価する

Ollamaを起動した状態で次のコマンドを実行すると、既定のGemma 4 12Bで観光・くらしの10問を試せます。全件の実行には数分かかることがあります。

```bash
python3 -B evaluate_rag.py --mode react --output evaluation-results.json
```

結果JSONには、実際の回答と出典、検索条件と取得した資料ID、応答時間が入ります。ReActの評価ではターンごとの行動も確認できます。大沢の日程表の例だけ試すには `--case collection-district-unknown` を追加します。`--mode` を省略すると、初回検索のみと旧版の追加検索ありを比較します。

質問と判定条件は [`evaluation/questions.json`](evaluation/questions.json) にあります。自動判定では回答に必要な語句・数値、資料ID・URL、ReActの行動を確認します。文全体で意味が合っているかは実際の回答も読みます。終了コードは全件合格が `0`、要確認の回答がある場合が `1`、実行エラーが `2` です。Ollamaを使わずに回数上限や出典の照合を試すには `python3 -B -m unittest discover -s tests` を実行します。

## 言い換えに対応する検索を試す

一般資料のキーワード検索に、EmbeddingGemmaによる意味の近さを使った検索を組み合わせられます。ローカルOllamaを起動し、このフォルダで以下を実行します。索引の初回作成にかかる時間は資料数と実行環境によります。 [Ollamaの埋め込みAPI](https://docs.ollama.com/api/embed) · [EmbeddingGemma 2](https://ollama.com/library/embeddinggemma-2:270m)

```bash
ollama pull embeddinggemma-2:270m
python3 -B -m yamada_embeddings
python3 -B evaluate_retrieval.py --mode keyword --mode semantic --mode hybrid --output retrieval-results.json
python3 -B yamada_web.py --model --retrieval hybrid
```

`evaluate_retrieval.py` は、正式名、言い換え、複数資料が必要な19問で、必要な根拠が上位3件に入ったかを測ります。回答生成も比較するには `evaluate_rag.py --mode react --retrieval hybrid` を実行します。検索方式の既定値はキーワードです。WebとCLIでは `--retrieval hybrid` で切り替え、ごみ収集日は専用の日付照合を使います。

索引の `embeddings-cache.json` は資料から再生成するローカルファイルです。資料を更新したら `python3 -B -m yamada_embeddings` で差分を反映します。索引や埋め込みサーバーを利用できないときはキーワード検索に切り替わります。埋め込み用Ollamaの接続先を変える場合は `YAMADA_EMBED_URL`、モデル名を変える場合は `YAMADA_EMBED_MODEL` を設定します。設定変更後は同じ設定で索引を生成してアプリを起動します。

GPUで動かすOllamaを別ポートに起動するなど、回答用の接続先を変えるときは `YAMADA_CHAT_URL` に `http://127.0.0.1:11435/api/chat` のように指定します。未設定の場合は `http://127.0.0.1:11434/api/chat` に接続します。

## 資料を増やすとき

山田町公式サイトの記事一覧と、山田町観光協会の名所・施設・宿泊の一覧などから、本文・見出し・出典URL・取得日と、取得できる場合は掲載日を保存します。初回と資料を更新したいときに、このフォルダで実行します。町の記事の確認には数分かかります。 [山田町の記事一覧](https://www.town.yamada.iwate.jp/docs/) · [山田町観光協会](https://www.yamada-kankou.jp/)

```bash
python3 -B import_town_knowledge.py
python3 -B import_town_knowledge.py --source tourism
python3 -B yamada_rag.py 'ふれあいセンターはぴねの休館日は？'
python3 -B yamada_rag.py '山田町の特産品のオランダ島サーモンとは？'
```

取得結果は `town_articles.json` と `tourism_articles.json` に保存されます。それぞれ本文と、取得できなかった記事のURL・理由が入ります。この2ファイルはローカル生成データです。更新後はWebサーバーを再起動すると、新しい資料を読み込みます。試しに少数のページを取得するときは `--limit 10 --output sample.json` のように別の保存先を指定できます。

施設名や品目と質問の項目が基本資料に一致したときは、その要約を優先します。その他の質問では、取得した記事の見出し・本文から候補を探します。記事の取り込みはHTML本文が対象です。地区別ごみ収集日には下記の日付データも使います。

`sources.json` に、交通事業者、地域団体、商店、漁協、地域メディアなどの確認済み情報を要約して登録します。資料ごとに分野・発信元・出典URL・確認日を置き、検索単位ごとに `id`、施設名や品目を探す `keywords`、開館時間や分別など質問の内容を見分ける `topics` を付けます。更新時は発信元のページを確認して要約と確認日を更新します。

人が書いて見直すFAQは `knowledge/` にMarkdownで保存できます。[町の花・木・鳥のFAQ](knowledge/town-symbols.md) の形式で、冒頭の `---` で囲まれた箇所に題名、分野、出典、URL、確認日、検索語と項目を置き、その後に本文を書きます。検索語と項目は半角カンマで区切ります。MarkdownとJSONは同じ資料検索で利用でき、単体HTMLには手作業で整えた資料が入ります。

`collection_calendars.json` に公式PDFと地区の対応、`collection_calendar_days.json` に令和8年度の区分別・品目別の日付を保存します。回答には日付と出典の文書名が表示されます。地区名が複数の収集区分にまたがる場合は、区番号やごみステーションの目印を尋ねます。相対的な日付は日本時間を基準にし、「次回」は翌日以降の予定を案内します。

日付データを照合し直すには、公式PDFを資料IDと同じ名前で保存し、`pdftotext` が使える環境で `python3 -B import_calendar_days.py --pdf-dir <PDFのフォルダ>` を実行します。各月の欄と燃やせるごみの曜日が公式表と一致した場合に、日付JSONを更新します。

ごみ収集日の回答は登録した年度の日程表に基づきます。12月29日〜31日が該当する場合は日程表の変更注意も表示します。臨時の営業変更、当日の運行やイベントの変更は各発信元が案内します。 [山田町の地区別ごみ収集日程表](https://www.town.yamada.iwate.jp/docs/8354.html)

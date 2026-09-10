# ご飯画像フォルダ

`mealImageHandler`(LLM不使用)が1日3回(既定: 朝8時±2時間、昼12時±1時間、
晩18時±1時間)、このフォルダから画像をランダムに選んで`config/settings.json`の
`mealPosts.channelId`で指定したチャンネルに投稿します。

画像だけでは朝食/昼食/夕食を区別できないため、フォルダは分けずこの直下に
まとめて置きます(投稿するタイミングだけ`mealPosts.meals`のmealKeyごとに
分かれています)。好きな画像ファイル(png/jpg/jpeg/gif/webp)を置いてください。
複数枚置いておくと、投稿のたびにランダムに1枚選ばれます。

投稿時刻・フォルダパス・対象チャンネルは`config/settings.json`の
`mealPosts`セクションで変更できます。

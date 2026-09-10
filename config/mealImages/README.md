# ご飯画像フォルダ

`mealImageHandler`(LLM不使用)が1日3回、ここから画像をランダムに選んで
`config/settings.json`の`mealPosts.channelId`で指定したチャンネルに投稿します。

- `breakfast/` … 朝ごはん(既定: 8時±2時間の間でランダムな時刻に投稿)
- `lunch/` … 昼ごはん(既定: 12時±1時間)
- `dinner/` … 晩ごはん(既定: 18時±1時間)

各フォルダに好きな画像ファイル(png/jpg/jpeg/gif/webp)を置いてください。
複数枚置いておくと、投稿のたびにランダムに1枚選ばれます。

投稿時刻・フォルダパス・対象チャンネルは`config/settings.json`の
`mealPosts`セクションで変更できます。

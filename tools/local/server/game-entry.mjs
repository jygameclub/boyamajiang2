function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderLocalGameEntry({ clientUrl, userToken }) {
  const safeClientUrl = escapeHtmlAttribute(clientUrl);
  const safeUserToken = escapeHtmlAttribute(userToken);
  return `<!doctype html>
<html lang="zh-CN" data-user-token="${safeUserToken}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <title>Mahjong Ways 2</title>
  <style>
    html, body, #local-game-frame { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; background: #333; }
    #local-game-frame { display: block; }
  </style>
</head>
<body>
  <iframe id="local-game-frame" src="${safeClientUrl}" allow="autoplay; fullscreen"></iframe>
</body>
</html>
`;
}

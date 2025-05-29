export const generateRouletteResultImage = async (
  canvasElement: HTMLCanvasElement,
  resultText: string
): Promise<Blob> => {
  // 新しいキャンバスを作成して結果画像を生成
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas context not available");
  }

  // キャンバスサイズを設定
  const width = 600;
  const height = 700;
  canvas.width = width;
  canvas.height = height;

  // 背景を白に設定
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // タイトルを描画
  ctx.fillStyle = "#333333";
  ctx.font = "bold 32px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("🎯 Lucky Roulette", width / 2, 50);

  // ルーレット画像を描画
  const rouletteY = 80;
  const rouletteSize = 400;
  const rouletteX = (width - rouletteSize) / 2;

  ctx.drawImage(
    canvasElement,
    rouletteX,
    rouletteY,
    rouletteSize,
    rouletteSize
  );

  // 結果テキストの背景を描画
  const resultY = rouletteY + rouletteSize + 40;
  const resultBoxHeight = 120;
  const resultBoxY = resultY - 20;

  // 結果ボックスの背景
  ctx.fillStyle = "#f8f9fa";
  ctx.strokeStyle = "#dee2e6";
  ctx.lineWidth = 2;
  ctx.roundRect(50, resultBoxY, width - 100, resultBoxHeight, 10);
  ctx.fill();
  ctx.stroke();

  // "結果" ラベルを描画
  ctx.fillStyle = "#6c757d";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText("結果", width / 2, resultY + 10);

  // 結果テキストを描画
  ctx.fillStyle = "#212529";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(resultText, width / 2, resultY + 60);

  // 日時を描画
  const now = new Date();
  const dateString = now.toLocaleString("ja-JP");
  ctx.fillStyle = "#6c757d";
  ctx.font = "16px sans-serif";
  ctx.fillText(dateString, width / 2, height - 30);

  // キャンバスをBlobに変換
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        throw new Error("Failed to generate image blob");
      }
    }, "image/png");
  });
};

export const copyImageToClipboard = async (blob: Blob): Promise<void> => {
  try {
    const clipboardItem = new ClipboardItem({ "image/png": blob });
    await navigator.clipboard.write([clipboardItem]);
  } catch (error) {
    console.error("Failed to copy image to clipboard:", error);
    throw new Error("クリップボードへのコピーに失敗しました");
  }
};

export const downloadImage = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

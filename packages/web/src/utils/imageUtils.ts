export const generateRouletteResultImage = async (
  canvasElement: HTMLCanvasElement,
  resultText: string,
  resultLabel: string,
  language: string
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
  ctx.fillText(resultLabel, width / 2, resultY + 10);

  // 結果テキストを描画
  ctx.fillStyle = "#212529";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(resultText, width / 2, resultY + 60);

  // 日時を描画
  const now = new Date();
  const dateString = now.toLocaleString(language);
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

interface BattleImageEntry {
  label: string;
  count: number;
  color: string;
}

export const generateBattleResultImage = async (
  entries: BattleImageEntry[],
  winner: string,
  titleText: string,
  winnerLabel: string,
  language: string
): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context not available");

  const width = 720;
  const padding = 40;
  const titleHeight = 80;
  const winnerBoxHeight = 120;
  const rowHeight = 52;
  const rowGap = 8;
  const footerHeight = 50;
  const maxVisibleRows = Math.min(entries.length, 12);
  const barsHeight = maxVisibleRows * rowHeight + (maxVisibleRows - 1) * rowGap;
  const height =
    padding + titleHeight + winnerBoxHeight + 32 + barsHeight + footerHeight + padding;

  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#333333";
  ctx.font = "bold 30px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(titleText, width / 2, padding + 36);

  const winnerBoxY = padding + titleHeight;
  ctx.fillStyle = "#fff3e0";
  ctx.strokeStyle = "#ffb74d";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(padding, winnerBoxY, width - padding * 2, winnerBoxHeight, 12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#e65100";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText(winnerLabel, width / 2, winnerBoxY + 36);

  ctx.fillStyle = "#bf360c";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(winner, width / 2, winnerBoxY + 84);

  const barsStartY = winnerBoxY + winnerBoxHeight + 32;
  const barAreaX = padding + 160;
  const barAreaWidth = width - padding - barAreaX - 8;
  const maxCount = Math.max(1, ...entries.map((e) => e.count));
  const visible = entries.slice(0, maxVisibleRows);

  visible.forEach((entry, i) => {
    const rowY = barsStartY + i * (rowHeight + rowGap);

    ctx.fillStyle = "#263238";
    ctx.font = "600 18px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(entry.label, padding + 150, rowY + rowHeight / 2 + 6);

    ctx.fillStyle = "#eceff1";
    ctx.beginPath();
    ctx.roundRect(barAreaX, rowY + 6, barAreaWidth, rowHeight - 12, 12);
    ctx.fill();

    const fillWidth = Math.max(4, (entry.count / maxCount) * barAreaWidth);
    ctx.fillStyle = entry.color;
    ctx.beginPath();
    ctx.roundRect(barAreaX, rowY + 6, fillWidth, rowHeight - 12, 12);
    ctx.fill();

    ctx.fillStyle = "#263238";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(
      entry.count.toString(),
      barAreaX + barAreaWidth - 12,
      rowY + rowHeight / 2 + 6
    );
  });

  const now = new Date();
  const dateString = now.toLocaleString(language);
  ctx.fillStyle = "#6c757d";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(dateString, width / 2, height - padding + 10);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else throw new Error("Failed to generate image blob");
    }, "image/png");
  });
};

interface GroupImageGroup {
  label: string;
  color: string;
  items: string[];
}

export const generateGroupResultImage = async (
  groups: GroupImageGroup[],
  titleText: string,
  resultLabel: string,
  language: string
): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context not available");

  const padding = 40;
  const columnGap = 20;
  const columns = groups.length <= 2 ? groups.length : groups.length <= 4 ? 2 : 3;
  const columnWidth = 260;
  const cardPadding = 16;
  const cardHeaderHeight = 48;
  const itemHeight = 28;
  const width = padding * 2 + columns * columnWidth + (columns - 1) * columnGap;
  const titleHeight = 80;

  const rows = Math.ceil(groups.length / columns);
  let maxItemsPerRow = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const idx = r * columns + c;
      if (idx >= groups.length) break;
      maxItemsPerRow = Math.max(maxItemsPerRow, groups[idx].items.length);
    }
  }
  const cardHeight =
    cardHeaderHeight + cardPadding * 2 + maxItemsPerRow * itemHeight;
  const rowGap = 20;
  const height =
    padding +
    titleHeight +
    rows * cardHeight +
    (rows - 1) * rowGap +
    60 +
    padding;

  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#333333";
  ctx.font = "bold 30px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(titleText, width / 2, padding + 36);

  ctx.fillStyle = "#6c757d";
  ctx.font = "18px sans-serif";
  ctx.fillText(resultLabel, width / 2, padding + 66);

  const cardsStartY = padding + titleHeight;

  groups.forEach((group, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = padding + col * (columnWidth + columnGap);
    const y = cardsStartY + row * (cardHeight + rowGap);

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, columnWidth, cardHeight, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = group.color;
    ctx.beginPath();
    ctx.roundRect(x, y, columnWidth, cardHeaderHeight, [12, 12, 0, 0]);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(group.label, x + columnWidth / 2, y + cardHeaderHeight / 2 + 6);

    ctx.fillStyle = "#333333";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "left";
    group.items.forEach((item, j) => {
      ctx.fillText(
        item,
        x + cardPadding,
        y + cardHeaderHeight + cardPadding + j * itemHeight + 16
      );
    });
  });

  const now = new Date();
  const dateString = now.toLocaleString(language);
  ctx.fillStyle = "#6c757d";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(dateString, width / 2, height - padding + 10);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else throw new Error("Failed to generate image blob");
    }, "image/png");
  });
};

export const copyImageToClipboard = async (blob: Blob): Promise<void> => {
  try {
    const clipboardItem = new ClipboardItem({ "image/png": blob });
    await navigator.clipboard.write([clipboardItem]);
  } catch (error) {
    console.error("Failed to copy image to clipboard:", error);
    throw new Error("Failed to copy to clipboard");
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

import { useState } from "react";
import {
  generateRouletteResultImage,
  copyImageToClipboard,
  downloadImage,
} from "../utils/imageUtils";

interface RouletteActionsProps {
  canvasElement: HTMLCanvasElement | null;
  currentOption: string;
  isVisible: boolean;
  onSuccess: (message: string) => void;
}

export const RouletteActions: React.FC<RouletteActionsProps> = ({
  canvasElement,
  currentOption,
  isVisible,
  onSuccess,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);

  const handleCopyToClipboard = async () => {
    if (!currentOption || !canvasElement) return;

    setIsGenerating(true);
    try {
      const imageBlob = await generateRouletteResultImage(
        canvasElement,
        currentOption
      );
      await copyImageToClipboard(imageBlob);
      onSuccess("結果画像をクリップボードにコピーしました！");
    } catch (error) {
      console.error("Error copying to clipboard:", error);
      onSuccess("クリップボードへのコピーに失敗しました。");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!currentOption || !canvasElement) return;

    setIsGenerating(true);
    try {
      const imageBlob = await generateRouletteResultImage(
        canvasElement,
        currentOption
      );
      const now = new Date();
      const filename = `roulette-result-${now.getFullYear()}${(
        now.getMonth() + 1
      )
        .toString()
        .padStart(2, "0")}${now.getDate().toString().padStart(2, "0")}-${now
        .getHours()
        .toString()
        .padStart(2, "0")}${now.getMinutes().toString().padStart(2, "0")}.png`;
      downloadImage(imageBlob, filename);
      onSuccess("結果画像をダウンロードしました！");
    } catch (error) {
      console.error("Error downloading image:", error);
      onSuccess("画像のダウンロードに失敗しました。");
    } finally {
      setIsGenerating(false);
    }
  };

  if (!isVisible) return null;

  return (
    <div className="roulette-actions">
      <button
        onClick={handleCopyToClipboard}
        disabled={isGenerating}
        className="action-button copy-action"
        title="結果画像をクリップボードにコピー"
      >
        📋
      </button>
      <button
        onClick={handleDownload}
        disabled={isGenerating}
        className="action-button download-action"
        title="結果画像をダウンロード"
      >
        💾
      </button>
      {isGenerating && (
        <div className="generating-indicator">
          <div className="spinner"></div>
        </div>
      )}
    </div>
  );
};

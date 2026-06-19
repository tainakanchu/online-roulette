import { useState } from "react";
import { useTranslation } from "react-i18next";
import { copyImageToClipboard, downloadImage } from "../utils/imageUtils";

interface RouletteActionsProps {
  canvasElement: HTMLCanvasElement | null;
  isVisible: boolean;
  onSuccess: (message: string) => void;
}

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to generate image blob"));
    }, "image/png");
  });

const buildFilename = (): string => {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `roulette-result-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
};

export const RouletteActions: React.FC<RouletteActionsProps> = ({
  canvasElement,
  isVisible,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [isGenerating, setIsGenerating] = useState(false);

  const handleCopyToClipboard = async () => {
    if (!canvasElement) return;
    setIsGenerating(true);
    try {
      const blob = await canvasToBlob(canvasElement);
      await copyImageToClipboard(blob);
      onSuccess(t("actions.copySuccess"));
    } catch (error) {
      console.error("Error copying to clipboard:", error);
      onSuccess(t("actions.copyError"));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!canvasElement) return;
    setIsGenerating(true);
    try {
      const blob = await canvasToBlob(canvasElement);
      downloadImage(blob, buildFilename());
      onSuccess(t("actions.downloadSuccess"));
    } catch (error) {
      console.error("Error downloading image:", error);
      onSuccess(t("actions.downloadError"));
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
        className="action-button"
        title={t("actions.copyTitle")}
      >
        📋
      </button>
      <button
        onClick={handleDownload}
        disabled={isGenerating}
        className="action-button"
        title={t("actions.downloadTitle")}
      >
        💾
      </button>
    </div>
  );
};

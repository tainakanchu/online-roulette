import { useState } from "react";
import { useTranslation } from "react-i18next";
import { copyImageToClipboard, downloadImage } from "../utils/imageUtils";

interface ImageActionsProps {
  /** コピー/ダウンロードするPNGのBlobを生成する */
  getBlob: () => Promise<Blob>;
  isVisible: boolean;
  onSuccess: (message: string) => void;
  /** ファイル名の接頭辞 (e.g. "roulette-result" → roulette-result-YYYYMMDD-HHMM.png) */
  filenamePrefix: string;
  /** 配置調整用の追加クラス（未指定なら従来どおり右上に絶対配置） */
  className?: string;
}

const buildFilename = (prefix: string): string => {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
};

export const ImageActions: React.FC<ImageActionsProps> = ({
  getBlob,
  isVisible,
  onSuccess,
  filenamePrefix,
  className,
}) => {
  const { t } = useTranslation();
  const [isGenerating, setIsGenerating] = useState(false);

  const handleCopyToClipboard = async () => {
    setIsGenerating(true);
    try {
      const blob = await getBlob();
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
    setIsGenerating(true);
    try {
      const blob = await getBlob();
      downloadImage(blob, buildFilename(filenamePrefix));
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
    <div className={`roulette-actions${className ? ` ${className}` : ""}`}>
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

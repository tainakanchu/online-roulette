import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { readLocalStorage, writeLocalStorage } from "../utils/localStorage";
import { useShakeSound } from "./useShakeSound";

import { shuffleArray } from "@tainakanchu/roulette-core";

const SHUFFLE_COUNT_STORAGE_KEY = "roulette-shuffle-count";
const QUICK_MODE_STORAGE_KEY = "roulette-quick-mode";

const toOptions = (text: string): string[] =>
  text
    .split("\n")
    .map((option) => option.trim())
    .filter((option) => option.length > 0);

interface UseRouletteOptionsProps {
  /** 選択肢の集合が変化したとき（追加・削除・全消去・一括編集）に呼ばれる */
  onOptionsMutated?: () => void;
}

export const useRouletteOptions = ({
  onOptionsMutated,
}: UseRouletteOptionsProps = {}) => {
  const shakeSound = useShakeSound();
  const [optionsText, setOptionsText] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const queryOptions = params.get("options");
    return queryOptions ? queryOptions.split(",").join("\n") : "";
  });
  const [newOption, setNewOption] = useState("");
  const [showBulkEdit, setShowBulkEdit] = useState(false);

  const [shuffleCount, setShuffleCount] = useState(() => {
    const storedValue = readLocalStorage(SHUFFLE_COUNT_STORAGE_KEY);
    const parsedValue = storedValue ? Number.parseInt(storedValue, 10) : NaN;
    if (!Number.isNaN(parsedValue) && parsedValue >= 1) {
      return parsedValue;
    }
    return 1;
  });

  const [quickMode, setQuickMode] = useState(() => {
    const storedValue = readLocalStorage(QUICK_MODE_STORAGE_KEY);
    return storedValue === "true";
  });

  useEffect(() => {
    writeLocalStorage(SHUFFLE_COUNT_STORAGE_KEY, shuffleCount.toString());
  }, [shuffleCount]);

  useEffect(() => {
    writeLocalStorage(QUICK_MODE_STORAGE_KEY, quickMode.toString());
  }, [quickMode]);

  const options = useMemo(() => toOptions(optionsText), [optionsText]);

  const hasOptions = options.length > 0;

  // URLを更新する関数
  const updateURL = useCallback((text: string) => {
    const options = toOptions(text).join(",");

    const url = new URL(window.location.href);
    if (options) {
      url.searchParams.set("options", options);
    } else {
      url.searchParams.delete("options");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  // optionsText と URL をまとめて更新し、結果のリセットを通知する
  const commitText = useCallback(
    (text: string) => {
      setOptionsText(text);
      updateURL(text);
      onOptionsMutated?.();
    },
    [updateURL, onOptionsMutated],
  );

  // 一括編集用テキストエリアの変更
  const handleOptionsChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      commitText(e.target.value);
    },
    [commitText],
  );

  const handleNewOptionChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setNewOption(e.target.value);
    },
    [],
  );

  // 選択肢を追加（カンマ・改行で複数同時追加に対応）
  const addOption = useCallback(() => {
    const raw = newOption.trim();
    if (!raw) return;
    const additions = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!additions.length) return;
    const current = toOptions(optionsText);
    commitText(current.concat(additions).join("\n"));
    setNewOption("");
  }, [newOption, optionsText, commitText]);

  const handleNewOptionKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addOption();
      }
    },
    [addOption],
  );

  const removeOption = useCallback(
    (index: number) => {
      const current = toOptions(optionsText);
      current.splice(index, 1);
      commitText(current.join("\n"));
    },
    [optionsText, commitText],
  );

  const clearOptions = useCallback(() => {
    commitText("");
  }, [commitText]);

  const toggleBulkEdit = useCallback(() => {
    setShowBulkEdit((prev) => !prev);
  }, []);

  const handleShuffleCountChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseInt(e.target.value, 10);
      if (!Number.isNaN(value) && value >= 1) {
        setShuffleCount(value);
      }
    },
    [],
  );

  const handleQuickModeChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setQuickMode(e.target.checked);
    },
    [],
  );

  const shuffleOptions = useCallback(() => {
    const optionsToShuffle = toOptions(optionsText);

    if (optionsToShuffle.length <= 1) {
      return;
    }

    // おみくじを振るような「シャカシャカ」音を開始
    shakeSound.start();
    let count = 0;

    const intervalId = setInterval(() => {
      count += 1;

      setOptionsText((currentText) => {
        const currentOptions = toOptions(currentText);

        const shuffled = shuffleArray(currentOptions);
        const nextText = shuffled.join("\n");

        if (count >= shuffleCount) {
          clearInterval(intervalId);
          shakeSound.stop();
          // 最後にURLを更新
          updateURL(nextText);
        }

        return nextText;
      });
    }, 5);
  }, [optionsText, shuffleCount, updateURL, shakeSound]);

  return {
    optionsText,
    options,
    hasOptions,
    newOption,
    showBulkEdit,
    handleOptionsChange,
    handleNewOptionChange,
    handleNewOptionKeyDown,
    addOption,
    removeOption,
    clearOptions,
    toggleBulkEdit,
    shuffleOptions,
    shuffleCount,
    handleShuffleCountChange,
    quickMode,
    handleQuickModeChange,
  };
};

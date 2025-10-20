import { useState, useCallback, useMemo, useEffect, type ChangeEvent } from "react";
import { readLocalStorage, writeLocalStorage } from "../utils/localStorage";

const shuffleArray = (items: string[]) => {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const SHUFFLE_COUNT_STORAGE_KEY = "roulette-shuffle-count";

export const useRouletteOptions = () => {
  const [optionsText, setOptionsText] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const queryOptions = params.get("options");
    return queryOptions ? queryOptions.split(",").join("\n") : "";
  });

  const [shuffleCount, setShuffleCount] = useState(() => {
    const storedValue = readLocalStorage(SHUFFLE_COUNT_STORAGE_KEY);
    const parsedValue = storedValue ? Number.parseInt(storedValue, 10) : NaN;
    if (!Number.isNaN(parsedValue) && parsedValue >= 1) {
      return parsedValue;
    }
    return 1;
  });

  useEffect(() => {
    writeLocalStorage(SHUFFLE_COUNT_STORAGE_KEY, shuffleCount.toString());
  }, [shuffleCount]);

  const options = useMemo(() => {
    return optionsText
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
  }, [optionsText]);

  const hasOptions = options.length > 0;

  // URLを更新する関数
  const updateURL = useCallback((text: string) => {
    const options = text
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
      .join(",");

    const url = new URL(window.location.href);
    if (options) {
      url.searchParams.set("options", options);
    } else {
      url.searchParams.delete("options");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  // テキストエリアの変更時にURLも更新
  const handleOptionsChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setOptionsText(newText);
      updateURL(newText);
    },
    [updateURL]
  );

  const handleShuffleCountChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseInt(e.target.value, 10);
      if (!Number.isNaN(value) && value >= 1) {
        setShuffleCount(value);
      }
    },
    []
  );

  const shuffleOptions = useCallback(() => {
    const optionsToShuffle = optionsText
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option.length > 0);

    if (optionsToShuffle.length <= 1) {
      return;
    }

    let count = 0;

    const intervalId = setInterval(() => {
      setOptionsText((currentText) => {
        const currentOptions = currentText
          .split("\n")
          .map((option) => option.trim())
          .filter((option) => option.length > 0);

        const shuffled = shuffleArray(currentOptions);
        const nextText = shuffled.join("\n");

        count += 1;
        if (count >= shuffleCount) {
          clearInterval(intervalId);
          // 最後にURLを更新
          updateURL(nextText);
        }

        return nextText;
      });
    }, 5);
  }, [optionsText, shuffleCount, updateURL]);

  return {
    optionsText,
    options,
    hasOptions,
    handleOptionsChange,
    shuffleOptions,
    shuffleCount,
    handleShuffleCountChange,
  };
};

"use strict";

//#region Config + Initial Setup
// Configuration object with default values
const CONFIG = {
  IMAGE_WIDTH: "400px",
  WIDE_MODE: true,
  ARROW_WIDTH: "45px",
  ARROW_HEIGHT: "35px",
  PAGE_WIDTH: "75rem",
  SOUND_VOLUME: 80,
  ENABLE_EXAMPLE_TRANSLATION: true,
  SENTENCE_FONT_SIZE: "120%",
  TRANSLATION_FONT_SIZE: "85%",
  COLORED_SENTENCE_TEXT: true,
  AUTO_PLAY_SOUND: true,
  NUMBER_OF_PRELOADS: 1,
  VOCAB_SIZE: "250%",
  MINIMUM_EXAMPLE_LENGTH: 0,
};

// State management object
const state = {
  currentExampleIndex: 0,
  examples: [],
  apiDataFetched: false,
  vocab: "",
  embedAboveSubsectionMeanings: false,
  preloadedIndices: new Set(),
  currentAudio: null,
  exactSearch: false,
  error: false,
  currentlyPlayingAudio: false,
  vocabContent: null,
};

// Chrome Storage Wrapper
const chromeStorage = {
  get: async (key) => {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        resolve(result[key]);
      });
    });
  },
  set: async (key, value) => {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  },
  remove: async (key) => {
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, resolve);
    });
  },
  getAll: async () => {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        resolve(items);
      });
    });
  },
};

// Utility function to replace GM_addElement
function addElement(parent, tag, attributes) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "style") {
      // Handle style object differently
      if (typeof value === "string") {
        element.setAttribute("style", value);
      } else {
        // Handle style object properties individually
        for (const [styleKey, styleValue] of Object.entries(value)) {
          element.style[styleKey] = styleValue;
        }
      }
    } else {
      element[key] = value;
    }
  }
  parent.appendChild(element);
  return element;
}

//#endregion

// #region IndexedDB Manager Implementation
/*
IndexedDBManager is a system for storing and managing data locally in the browser.
It's used to cache the responses from the ImmersionKit API & store them permanently.
*/
const IndexedDBManager = {
  MAX_ENTRIES: 100000000,
  EXPIRATION_TIME: 30 * 24 * 60 * 60 * 1000 * 12 * 10000, // 10000 years in milliseconds

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("ImmersionKitDB", 1);
      request.onupgradeneeded = function (event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("dataStore")) {
          db.createObjectStore("dataStore", { keyPath: "keyword" });
        }
      };
      request.onsuccess = function (event) {
        resolve(event.target.result);
      };
      request.onerror = function (event) {
        reject("IndexedDB error: " + event.target.errorCode);
      };
    });
  },

  async get(db, keyword) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["dataStore"], "readonly");
      const store = transaction.objectStore("dataStore");
      const request = store.get(keyword);
      request.onsuccess = async function (event) {
        const result = event.target.result;
        if (result) {
          const isExpired =
            Date.now() - result.timestamp >= this.EXPIRATION_TIME;
          const validationError = validateApiResponse(result.data);

          if (isExpired) {
            console.log(
              `Deleting entry for keyword "${keyword}" because it is expired.`
            );
            await this.deleteEntry(db, keyword);
            resolve(null);
          } else if (validationError) {
            console.log(
              `Deleting entry for keyword "${keyword}" due to validation error: ${validationError}`
            );
            await this.deleteEntry(db, keyword);
            resolve(null);
          } else {
            resolve(result.data);
          }
        } else {
          resolve(null);
        }
      }.bind(this);
      request.onerror = function (event) {
        reject("IndexedDB get error: " + event.target.errorCode);
      };
    });
  },

  async deleteEntry(db, keyword) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["dataStore"], "readwrite");
      const store = transaction.objectStore("dataStore");
      const request = store.delete(keyword);
      request.onsuccess = () => resolve();
      request.onerror = (e) =>
        reject("IndexedDB delete error: " + e.target.errorCode);
    });
  },

  async getAll(db) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["dataStore"], "readonly");
      const store = transaction.objectStore("dataStore");
      const entries = [];
      store.openCursor().onsuccess = function (event) {
        const cursor = event.target.result;
        if (cursor) {
          entries.push(cursor.value);
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
      store.openCursor().onerror = function (event) {
        reject(
          "Failed to retrieve entries via cursor: " + event.target.errorCode
        );
      };
    });
  },

  async save(db, keyword, data) {
    return new Promise(async (resolve, reject) => {
      try {
        const validationError = validateApiResponse(data);
        if (validationError) {
          console.log(
            `Invalid data detected: ${validationError}. Not saving to IndexedDB.`
          );
          resolve();
          return;
        }

        // Transform the JSON object to slim it down
        let slimData = {};
        if (data && data.data) {
          slimData.data = data.data.map((item) => {
            const slimItem = {};

            if (item.category_count) {
              slimItem.category_count = item.category_count;
            }

            if (item.examples && Array.isArray(item.examples)) {
              slimItem.examples = item.examples.map((example) => ({
                image_url: example.image_url,
                sound_url: example.sound_url,
                sentence: example.sentence,
                translation: example.translation,
                deck_name: example.deck_name,
              }));
            }

            return slimItem;
          });
        } else {
          console.error(
            "Data does not contain expected structure. Cannot slim down."
          );
          resolve();
          return;
        }

        const entries = await this.getAll(db);
        const transaction = db.transaction(["dataStore"], "readwrite");
        const store = transaction.objectStore("dataStore");

        if (entries.length >= this.MAX_ENTRIES) {
          entries.sort((a, b) => a.timestamp - b.timestamp);
          const entriesToDelete = entries.slice(
            0,
            entries.length - this.MAX_ENTRIES + 1
          );
          entriesToDelete.forEach((entry) => {
            store.delete(entry.keyword).onerror = function () {
              console.error("Failed to delete entry:", entry.keyword);
            };
          });
        }

        const addRequest = store.put({
          keyword,
          data: slimData,
          timestamp: Date.now(),
        });
        addRequest.onsuccess = () => resolve();
        addRequest.onerror = (e) =>
          reject("IndexedDB save error: " + e.target.errorCode);
      } catch (error) {
        reject(`Error in saveToIndexedDB: ${error}`);
      }
    });
  },

  async delete() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("ImmersionKitDB");
      request.onsuccess = function () {
        console.log("IndexedDB deleted successfully");
        resolve();
      };
      request.onerror = function (event) {
        console.error("Error deleting IndexedDB:", event.target.errorCode);
        reject("Error deleting IndexedDB: " + event.target.errorCode);
      };
      request.onblocked = function () {
        console.warn(
          "Delete operation blocked. Please close all other tabs with this site open and try again."
        );
        reject("Delete operation blocked");
      };
    });
  },
};
//#endregion

// #region API Functions

// Vocabulary sorting constants and utilities
// It uses sorted-vocab.csv (a list of Genki words) to sort the examples.
// If the current word is found in that list, it will try to find examples
// with vocabulary at similar lesson levels or below.
const SORT_WEIGHTS = {
  length: 0.3, // Moderate emphasis on sentence length
  vocab: 0.5, // Stronger emphasis on known vocabulary
  proximity: 0.2, // Moderate emphasis on words from same lesson
};
// The weights are conservative because the segmentation from the API is
// kind of inaccurate, especially for verbs.

const OPTIMAL_LENGTH = 30; // Target sentence length

// Process vocabulary list from CSV content
function processVocabList(content) {
  if (!content) {
    return {
      entries: [],
      kanjiMap: new Map(),
      kanaMap: new Map(),
    };
  }

  const entries = [];
  const kanjiMap = new Map();
  const kanaMap = new Map();

  content.split("\n").forEach((line) => {
    const parts = line.split(",");
    if (parts.length >= 6) {
      const [, kana, kanji, , , lesson] = parts.map((p) => p.trim());
      if (kana && lesson) {
        const lessonNum = getLessonNumber(lesson);
        const entry = {
          kana,
          kanji: kanji || null,
          lesson: lessonNum,
        };
        entries.push(entry);

        if (kanji) {
          kanjiMap.set(kanji, lessonNum);
        }
        kanaMap.set(kana, lessonNum);
      }
    }
  });

  return { entries, kanjiMap, kanaMap };
}

function getLessonNumber(lesson) {
  if (lesson === "会G") return 0;
  const match = lesson.match(/L(\d+)/);
  return match ? parseInt(match[1]) : Infinity;
}

function calculateSentenceScore(
  sentence,
  wordList,
  kanjiMap,
  kanaMap,
  targetWord,
  targetLesson
) {
  if (wordList.length === 0) return 0;

  const otherWords = wordList.filter((word) => word !== targetWord);
  if (otherWords.length === 0) return 0;

  let knownWords = 0;
  let proximitySum = 0;
  let proximityCounts = 0;

  otherWords.forEach((word) => {
    const lessonNum = kanjiMap.get(word) ?? kanaMap.get(word) ?? Infinity;
    if (lessonNum <= targetLesson) {
      knownWords++;
      const lessonDiff = targetLesson - lessonNum;
      const proximityScore = Math.exp(-lessonDiff / 2);
      proximitySum += proximityScore;
      proximityCounts++;
    }
  });

  const vocabScore = 1 - Math.exp(-knownWords / 5);
  const proximityScore =
    proximityCounts > 0 ? proximitySum / proximityCounts : 0;

  let lengthScore;
  if (sentence.length <= OPTIMAL_LENGTH) {
    lengthScore = 1.0;
  } else {
    const excess = sentence.length - OPTIMAL_LENGTH;
    lengthScore = Math.exp(-excess / 20);
  }

  return (
    vocabScore * SORT_WEIGHTS.vocab +
    lengthScore * SORT_WEIGHTS.length +
    proximityScore * SORT_WEIGHTS.proximity
  );
}

function rankExamples(examples, targetWord, vocabData) {
  const { kanjiMap, kanaMap } = vocabData;
  const targetLesson = kanjiMap.get(targetWord) ?? kanaMap.get(targetWord);

  if (targetLesson === undefined) return examples;

  const scoredExamples = examples.map((example) => ({
    example,
    score: calculateSentenceScore(
      example.sentence,
      example.word_list,
      kanjiMap,
      kanaMap,
      targetWord,
      targetLesson
    ),
  }));

  scoredExamples.sort((a, b) => b.score - a.score);
  return scoredExamples.map(({ example }) => example);
}

async function getImmersionKitData(vocab, exactSearch) {
  const searchVocab = exactSearch ? `「${vocab}」` : vocab;
  const url = `https://api.immersionkit.com/look_up_dictionary?keyword=${encodeURIComponent(
    searchVocab
  )}`;
  const maxRetries = 5;
  let attempt = 0;

  async function fetchData() {
    try {
      const db = await IndexedDBManager.open();
      const cachedData = await IndexedDBManager.get(db, searchVocab);

      if (
        cachedData &&
        Array.isArray(cachedData.data) &&
        cachedData.data.length > 0
      ) {
        // Just use the cached examples directly without ranking since they were already ranked
        state.examples = cachedData.data[0].examples;
        state.apiDataFetched = true;
        return;
      }

      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const jsonData = await response.json();

        const validationError = validateApiResponse(jsonData);
        if (!validationError) {
          // Rank the examples before saving to cache
          const vocabData = processVocabList(state.vocabContent);
          state.examples = rankExamples(
            jsonData.data[0].examples,
            vocab,
            vocabData
          );
          state.apiDataFetched = true;

          // Create a slim version with the ranked examples for saving
          const slimData = {
            data: [
              {
                category_count: jsonData.data[0].category_count,
                examples: state.examples,
              },
            ],
          };
          await IndexedDBManager.save(db, searchVocab, slimData);
        } else {
          attempt++;
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return fetchData();
          } else {
            throw new Error(
              `Invalid API response after ${maxRetries} attempts: ${validationError}`
            );
          }
        }
      } catch (error) {
        throw new Error(`Fetch error: ${error.message}`);
      }
    } catch (error) {
      console.error(`Error in fetchData: ${error}`);
      state.error = true;
      embedImageAndPlayAudio();
      throw error;
    }
  }

  await fetchData();
}

async function findExampleBySentence(sentence, occurrenceIndex) {
  const searchUrl = `https://api.immersionkit.com/look_up_dictionary?keyword=${encodeURIComponent(
    `「${sentence}」`
  )}`;

  try {
    const response = await fetch(searchUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const jsonData = await response.json();

    // Look through all examples across all search results
    let matchingExamples = [];
    if (jsonData?.data) {
      for (const data of jsonData.data) {
        if (data.examples) {
          matchingExamples = matchingExamples.concat(
            data.examples.filter((example) => example.sentence === sentence)
          );
        }
      }

      if (matchingExamples.length > occurrenceIndex) {
        return matchingExamples[occurrenceIndex];
      }
    }
  } catch (error) {
    console.error("Error finding example by sentence:", error);
  }

  return null;
}

function validateApiResponse(jsonData) {
  state.error = false;
  if (!jsonData) {
    return "Not a valid JSON";
  }
  if (!jsonData.data || !jsonData.data[0] || !jsonData.data[0].examples) {
    return "Missing required data fields";
  }

  const categoryCount = jsonData.data[0].category_count;
  if (!categoryCount) {
    return "Missing category count";
  }

  const allZero = Object.values(categoryCount).every((count) => count === 0);
  if (allZero) {
    return "Blank API";
  }

  return null;
}
// #endregion

// #region Storage Functions
async function getStoredData(key) {
  const storedValue = await chromeStorage.get(key);
  if (storedValue) {
    const [image_url, sound_url, sentence] = storedValue.split(",");
    return {
      image_url,
      sound_url,
      sentence,
    };
  }

  // Check defaults if no user favorite exists
  if (DEFAULT_FAVORITES[key]) {
    const [image_url, sound_url, sentence] = DEFAULT_FAVORITES[key];
    return {
      image_url,
      sound_url,
      sentence,
    };
  }

  return null;
}

async function storeData(key, image_url, sound_url, sentence) {
  const value = `${image_url},${sound_url},${sentence}`;
  await chromeStorage.set(key, value);
}

// Parse Functions
function parseVocabFromAnswer() {
  const elements = document.querySelectorAll(
    'a[href*="/kanji/"], a[href*="/vocabulary/"]'
  );
  console.log("Parsing Answer Page");

  for (const element of elements) {
    const href = element.getAttribute("href");
    const text = element.textContent.trim();

    const match = href.match(/\/(kanji|vocabulary)\/(?:\d+\/)?([^\#]*)#/);
    if (match) return match[2].trim();
    if (text) return text.trim();
  }
  return "";
}

function parseVocabFromReview() {
  const kindElement = document.querySelector(".kind");
  console.log("Parsing Review Page");

  const kindText = kindElement ? kindElement.textContent.trim() : "";

  if (kindText !== "Kanji" && kindText !== "Vocabulary" && kindText !== "New")
    return "";

  if (kindText === "Vocabulary" || kindText === "New") {
    const plainElement = document.querySelector(".plain");
    if (!plainElement) return "";

    let vocabulary = plainElement.textContent.trim();
    const nestedVocabularyElement =
      plainElement.querySelector("div:not([style])");

    if (nestedVocabularyElement) {
      vocabulary = nestedVocabularyElement.textContent.trim();
    }
    const specificVocabularyElement =
      plainElement.querySelector("div:nth-child(3)");

    if (specificVocabularyElement) {
      vocabulary = specificVocabularyElement.textContent.trim();
    }

    const kanjiRegex = /[\u4e00-\u9faf\u3400-\u4dbf]/;
    if (kanjiRegex.test(vocabulary) || vocabulary) {
      console.log("Found Vocabulary:", vocabulary);
      return vocabulary;
    }
  } else if (kindText === "Kanji") {
    const hiddenInput = document.querySelector('input[name="c"]');
    if (!hiddenInput) return "";

    const vocab = hiddenInput.value.split(",")[1];
    const kanjiRegex = /[\u4e00-\u9faf\u3400-\u4dbf]/;
    if (kanjiRegex.test(vocab)) {
      console.log("Found Kanji:", vocab);
      return vocab;
    }
  }
  return "";
}

function parseVocabFromVocabulary() {
  let url = window.location.href;
  url = url.split("?")[0].split("#")[0];
  const match = url.match(/https:\/\/jpdb\.io\/vocabulary\/(\d+)\/([^\#\/]*)/);
  console.log("Parsing Vocabulary Page");

  if (match) {
    state.embedAboveSubsectionMeanings = true;
    return decodeURIComponent(match[2]);
  }
  return "";
}

function parseVocabFromKanji() {
  const url = window.location.href;
  const match = url.match(/https:\/\/jpdb\.io\/kanji\/(\d+)\/([^\#]*)#a/);
  console.log("Parsing Kanji Page");

  if (match) {
    state.embedAboveSubsectionMeanings = true;
    let kanji = match[2];
    kanji = kanji.split("/")[0];
    return decodeURIComponent(kanji);
  }
  return "";
}

function parseVocabFromSearch() {
  let url = window.location.href;
  const match = url.match(/https:\/\/jpdb\.io\/search\?q=([^&+]*)/);
  console.log("Parsing Search Page");

  if (match) {
    return decodeURIComponent(match[1]);
  }
  return "";
}
// #endregion

// #region UI Component Creation Functions
function createAnchor(marginLeft) {
  const anchor = document.createElement("a");
  anchor.href = "#";
  anchor.style.border = "0";
  anchor.style.display = "inline-flex";
  anchor.style.verticalAlign = "middle";
  anchor.style.marginLeft = marginLeft;
  return anchor;
}

function createIcon(iconClass, fontSize = "1.4rem", color = "#3d81ff") {
  const icon = document.createElement("i");
  icon.className = iconClass;
  icon.style.fontSize = fontSize;
  icon.style.opacity = "1.0";
  icon.style.verticalAlign = "baseline";
  icon.style.color = color;
  return icon;
}

async function createSpeakerButton(soundUrl) {
  const anchor = createAnchor("0.5rem");
  const icon = createIcon("ti ti-volume");
  anchor.appendChild(icon);
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    playAudio(soundUrl);
  });
  return anchor;
}

async function createStarButton() {
  const anchor = createAnchor("0.5rem");
  const starIcon = document.createElement("span");
  const storedValue = await chromeStorage.get(state.vocab);
  const currentExample = state.examples[state.currentExampleIndex];

  if (storedValue && currentExample) {
    const [storedImageUrl] = storedValue.split(",");
    starIcon.textContent =
      currentExample.image_url === storedImageUrl ? "★" : "☆";
  } else {
    starIcon.textContent = "☆";
  }

  starIcon.style.fontSize = "1.4rem";
  starIcon.style.color = "#3D8DFF";
  starIcon.style.verticalAlign = "middle";
  starIcon.style.position = "relative";
  starIcon.style.top = "-2px";

  anchor.appendChild(starIcon);
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    toggleStarState(starIcon);
  });

  return anchor;
}

async function toggleStarState(starIcon) {
  const storedValue = await chromeStorage.get(state.vocab);

  const currentExample = state.examples[state.currentExampleIndex];
  if (
    !currentExample ||
    !currentExample.image_url ||
    !currentExample.sound_url
  ) {
    return;
  }

  if (storedValue) {
    await chromeStorage.remove(state.vocab);
    starIcon.textContent = "☆";
  } else {
    await storeData(
      state.vocab,
      currentExample.image_url,
      currentExample.sound_url,
      currentExample.sentence
    );
    starIcon.textContent = "★";
  }
}

function createQuoteButton() {
  const anchor = createAnchor("0rem");
  const quoteIcon = document.createElement("span");

  quoteIcon.innerHTML = state.exactSearch ? "<b>「」</b>" : "『』";

  quoteIcon.style.fontSize = "1.1rem";
  quoteIcon.style.color = "#3D8DFF";
  quoteIcon.style.verticalAlign = "middle";
  quoteIcon.style.position = "relative";
  quoteIcon.style.top = "0px";

  anchor.appendChild(quoteIcon);
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    toggleQuoteState(quoteIcon);
  });

  return anchor;
}

async function toggleQuoteState(quoteIcon) {
  const storedValue = await chromeStorage.get(state.vocab);
  const isBlacklisted =
    storedValue &&
    storedValue.split(",").length > 1 &&
    parseInt(storedValue.split(",")[1], 10) === 2;

  if (isBlacklisted) {
    return;
  }

  state.exactSearch = !state.exactSearch;
  quoteIcon.innerHTML = state.exactSearch ? "<b>「」</b>" : "『』";

  const storedData = await getStoredData(state.vocab);
  if (storedData && storedData.exactState === state.exactSearch) {
    state.currentExampleIndex = storedData.index;
  } else {
    state.currentExampleIndex = 0;
  }

  state.apiDataFetched = false;
  embedImageAndPlayAudio();
  try {
    await getImmersionKitData(state.vocab, state.exactSearch);
    embedImageAndPlayAudio();
  } catch (error) {
    console.error(error);
  }
}
// #endregion

// #region Menu Functions
function createMenuButton() {
  const anchor = createAnchor("0.5rem");
  const menuIcon = document.createElement("span");
  menuIcon.innerHTML = "☰";

  menuIcon.style.fontSize = "1.4rem";
  menuIcon.style.color = "#3D8DFF";
  menuIcon.style.verticalAlign = "middle";
  menuIcon.style.position = "relative";
  menuIcon.style.top = "-2px";

  anchor.appendChild(menuIcon);
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    const overlay = createOverlayMenu();
    document.body.appendChild(overlay);
  });

  return anchor;
}

function createOverlayMenu() {
  const overlay = document.createElement("div");
  overlay.id = "overlayMenu";
  overlay.style.position = "fixed";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.backgroundColor = "rgba(0, 0, 0, 0.75)";
  overlay.style.zIndex = "1000";
  overlay.style.display = "flex";
  overlay.style.justifyContent = "center";
  overlay.style.alignItems = "center";

  const menuContent = document.createElement("div");
  menuContent.style.backgroundColor = "var(--background-color)";
  menuContent.style.color = "var(--text-color)";
  menuContent.style.padding = "20px";
  menuContent.style.borderRadius = "5px";
  menuContent.style.boxShadow = "0 0 10px rgba(0, 0, 0, 0.5)";
  menuContent.style.width = "80%";
  menuContent.style.maxWidth = "550px";
  menuContent.style.maxHeight = "80%";
  menuContent.style.overflowY = "auto";

  // Add configuration options
  addConfigOptions(menuContent);

  // Add menu buttons
  const menuButtons = createMenuButtons();
  menuContent.appendChild(menuButtons);

  overlay.appendChild(menuContent);
  return overlay;
}

function addConfigOptions(menuContent) {
  const container = document.createElement("div");
  container.style.display = "grid";
  container.style.gridTemplateColumns = "1fr 25px 45px 25px"; // Label, -, Value, +
  container.style.gap = "5px";
  container.style.alignItems = "center";

  for (const [key, value] of Object.entries(CONFIG)) {
    const label = document.createElement("label");
    label.textContent = key
      .replace(/_/g, " ")
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
    label.style.textAlign = "left";

    if (typeof value === "boolean") {
      const checkboxContainer = document.createElement("div");
      checkboxContainer.style.gridColumn = "2 / span 3";
      checkboxContainer.style.display = "flex";
      checkboxContainer.style.justifyContent = "center";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = value;
      checkbox.setAttribute("data-key", key);
      checkbox.setAttribute("data-type", "boolean");
      checkbox.setAttribute("data-type-part", "");

      checkboxContainer.appendChild(checkbox);
      container.appendChild(label);
      container.appendChild(checkboxContainer);
    } else {
      const valueSpan = document.createElement("span");
      valueSpan.textContent = value.toString().replace(/[px%rem]+$/, "");
      valueSpan.style.textAlign = "center";
      valueSpan.style.minWidth = "40px";
      valueSpan.setAttribute("data-key", key);
      valueSpan.setAttribute("data-type", typeof value);
      valueSpan.setAttribute(
        "data-type-part",
        (value.toString().match(/[px%rem]+$/) || [""])[0]
      );

      const decrementBtn = createButton("-", () => updateValue("decrease"));
      const incrementBtn = createButton("+", () => updateValue("increase"));

      function updateValue(action) {
        const currentValue = parseFloat(valueSpan.textContent);
        const increment = currentValue >= 200 ? 25 : currentValue >= 20 ? 5 : 1;
        const newValue =
          action === "increase"
            ? currentValue + increment
            : currentValue - increment;

        if (newValue >= 0 && (key !== "SOUND_VOLUME" || newValue <= 100)) {
          valueSpan.textContent = newValue.toString();
          updateButtonStates();
        }
      }

      function updateButtonStates() {
        const currentValue = parseFloat(valueSpan.textContent);
        decrementBtn.disabled = currentValue <= 0;
        decrementBtn.style.color = currentValue <= 0 ? "grey" : "";
        incrementBtn.disabled = key === "SOUND_VOLUME" && currentValue >= 100;
        incrementBtn.style.color =
          key === "SOUND_VOLUME" && currentValue >= 100 ? "grey" : "";
      }

      container.appendChild(label);
      container.appendChild(decrementBtn);
      container.appendChild(valueSpan);
      container.appendChild(incrementBtn);
      updateButtonStates();
    }
  }

  menuContent.appendChild(container);
}

function createInputElement(container, key, value) {
  if (typeof value === "boolean") {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = value;
    checkbox.setAttribute("data-key", key);
    checkbox.setAttribute("data-type", "boolean");
    checkbox.setAttribute("data-type-part", "");
    container.appendChild(checkbox);
  } else if (typeof value === "number" || typeof value === "string") {
    const inputWrapper = document.createElement("div");
    inputWrapper.style.display = "flex";
    inputWrapper.style.alignItems = "center";

    const decrementBtn = createButton("-", () => updateValue("decrease"));
    const valueSpan = document.createElement("span");
    valueSpan.textContent = value.toString();
    valueSpan.style.margin = "0 10px";
    valueSpan.style.minWidth = "3ch";
    valueSpan.style.textAlign = "center";
    valueSpan.setAttribute("data-key", key);
    valueSpan.setAttribute("data-type", typeof value);
    valueSpan.setAttribute(
      "data-type-part",
      typeof value === "string" ? "(px)" : ""
    );

    const incrementBtn = createButton("+", () => updateValue("increase"));

    function updateValue(action) {
      const currentValue = parseFloat(valueSpan.textContent);
      const increment = currentValue >= 200 ? 25 : currentValue >= 20 ? 5 : 1;
      const newValue =
        action === "increase"
          ? currentValue + increment
          : currentValue - increment;

      if (newValue >= 0 && (key !== "SOUND_VOLUME" || newValue <= 100)) {
        valueSpan.textContent = newValue.toString();
        updateButtonStates();
      }
    }

    function updateButtonStates() {
      const currentValue = parseFloat(valueSpan.textContent);
      decrementBtn.disabled = currentValue <= 0;
      decrementBtn.style.color = currentValue <= 0 ? "grey" : "";
      incrementBtn.disabled = key === "SOUND_VOLUME" && currentValue >= 100;
      incrementBtn.style.color =
        key === "SOUND_VOLUME" && currentValue >= 100 ? "grey" : "";
    }

    inputWrapper.append(decrementBtn, valueSpan, incrementBtn);
    container.appendChild(inputWrapper);
    updateButtonStates();
  }
}

function createButton(text, onClick) {
  const button = document.createElement("button");
  button.textContent = text;
  button.style.width = "30px";
  button.style.height = "30px";
  button.style.padding = "0";
  button.style.display = "flex";
  button.style.justifyContent = "center";
  button.style.alignItems = "center";
  button.style.borderRadius = "4px";
  button.addEventListener("click", onClick);
  return button;
}

function createMenuButtons() {
  const buttonContainer = document.createElement("div");
  buttonContainer.style.display = "grid";
  buttonContainer.style.gridTemplateColumns = "repeat(3, 1fr)";
  buttonContainer.style.gap = "10px";
  buttonContainer.style.marginTop = "20px";
  buttonContainer.style.padding = "0 20px";

  const closeButton = document.createElement("button");
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => {
    const overlay = document.getElementById("overlayMenu");
    if (overlay) overlay.remove();
  });

  const saveButton = document.createElement("button");
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", saveConfig);

  const defaultButton = document.createElement("button");
  defaultButton.textContent = "Default";
  defaultButton.style.backgroundColor = "#C82800";
  defaultButton.style.color = "white";
  defaultButton.addEventListener("click", () => {
    createConfirmationPopup(
      "This will reset all your settings to default. Are you sure?",
      async () => {
        for (const key of Object.keys(await chromeStorage.getAll())) {
          if (key.startsWith("CONFIG.")) {
            await chromeStorage.remove(key);
          }
        }
        location.reload();
      },
      () => {
        const overlay = document.getElementById("overlayMenu");
        if (overlay) overlay.remove();
        document.body.appendChild(createOverlayMenu());
      }
    );
  });

  // Add styles to all buttons
  [closeButton, saveButton, defaultButton].forEach((button) => {
    button.style.padding = "8px 0";
    button.style.width = "100%";
    button.style.borderRadius = "4px";
  });

  buttonContainer.append(closeButton, saveButton, defaultButton);
  return buttonContainer;
}

function createActionButton(text, onClick) {
  const button = document.createElement("button");
  button.textContent = text;
  button.style.padding = "8px 0";
  button.style.width = "100%";
  button.style.borderRadius = "4px";
  button.addEventListener("click", onClick);
  return button;
}

function createConfirmationPopup(message, onYes, onNo) {
  const popupOverlay = document.createElement("div");
  popupOverlay.style.position = "fixed";
  popupOverlay.style.top = "0";
  popupOverlay.style.left = "0";
  popupOverlay.style.width = "100%";
  popupOverlay.style.height = "100%";
  popupOverlay.style.backgroundColor = "rgba(0, 0, 0, 0.75)";
  popupOverlay.style.zIndex = "1001";
  popupOverlay.style.display = "flex";
  popupOverlay.style.justifyContent = "center";
  popupOverlay.style.alignItems = "center";

  const popupContent = document.createElement("div");
  popupContent.style.backgroundColor = "var(--background-color)";
  popupContent.style.padding = "20px";
  popupContent.style.borderRadius = "5px";
  popupContent.style.textAlign = "center";

  const messageElem = document.createElement("p");
  messageElem.textContent = message;

  const yesButton = document.createElement("button");
  yesButton.textContent = "Yes";
  yesButton.style.backgroundColor = "#C82800";
  yesButton.style.marginRight = "10px";
  yesButton.addEventListener("click", () => {
    onYes();
    document.body.removeChild(popupOverlay);
  });

  const noButton = document.createElement("button");
  noButton.textContent = "No";
  noButton.addEventListener("click", () => {
    onNo();
    document.body.removeChild(popupOverlay);
  });

  popupContent.append(messageElem, yesButton, noButton);
  popupOverlay.appendChild(popupContent);
  document.body.appendChild(popupOverlay);
}

async function saveConfig() {
  const overlay = document.getElementById("overlayMenu");
  if (!overlay) return;

  const changes = {};
  const inputs = overlay.querySelectorAll("input[data-key], span[data-key]");

  for (const input of inputs) {
    const key = input.getAttribute("data-key");
    const type = input.getAttribute("data-type");

    if (!key || !type || !CONFIG.hasOwnProperty(key)) continue;

    let value;
    if (type === "boolean") {
      value = input.checked;
    } else if (type === "number") {
      value = parseFloat(input.textContent);
    } else if (type === "string") {
      value = input.textContent + (input.getAttribute("data-type-part") || "");
    }

    // Only save if value is valid and different from current
    if (value !== undefined && value !== CONFIG[key]) {
      changes[`CONFIG.${key}`] = value;
      CONFIG[key] = value; // Update current config immediately
    }
  }

  // Save changes to chrome.storage
  if (Object.keys(changes).length > 0) {
    for (const [key, value] of Object.entries(changes)) {
      await chromeStorage.set(key, value);
    }
  }

  // Refresh display
  renderImageAndPlayAudio(state.vocab, CONFIG.AUTO_PLAY_SOUND);
  setVocabSize();
  setPageWidth();

  // Close menu
  overlay.remove();
}
// #endregion

// #region Audio Functions
function stopCurrentAudio() {
  if (!state.currentAudio) return;

  try {
    state.currentAudio.source.stop();
    state.currentAudio.context.close();
  } catch (error) {
    console.error("Error stopping audio:", error);
  }

  state.currentAudio = null;
  state.currentlyPlayingAudio = false;
}

async function playAudio(soundUrl) {
  if (!soundUrl) return;
  stopCurrentAudio();
  await new Promise((resolve) => setTimeout(resolve, 50));

  try {
    state.currentlyPlayingAudio = true;
    const response = await fetch(soundUrl);
    const audioContext = new (window.AudioContext ||
      window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(
      await response.arrayBuffer()
    );

    if (state.currentlyPlayingAudio && state.currentAudio) {
      audioContext.close();
      return;
    }

    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();

    source.buffer = audioBuffer;
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(
      CONFIG.SOUND_VOLUME / 100,
      audioContext.currentTime + 0.1
    );

    source.start(0, 0.05);
    state.currentAudio = { context: audioContext, source };

    source.onended = source.onerror = () => {
      state.currentlyPlayingAudio = false;
      state.currentAudio?.context.close();
      state.currentAudio = null;
    };
  } catch (error) {
    console.error("Error playing audio:", error);
    state.currentlyPlayingAudio = false;
    state.currentAudio?.context.close();
    state.currentAudio = null;
  }
}
// #endregion

// #region Container Management Functions
function removeExistingContainer() {
  const existingContainer = document.getElementById("immersion-kit-container");
  if (existingContainer) {
    existingContainer.remove();
  }
}

function shouldRenderContainer() {
  const resultVocabularySection = document.querySelector(".result.vocabulary");
  const hboxWrapSection = document.querySelector(".hbox.wrap");
  const subsectionMeanings = document.querySelector(".subsection-meanings");
  const subsectionLabels = document.querySelectorAll("h6.subsection-label");
  return (
    resultVocabularySection ||
    hboxWrapSection ||
    subsectionMeanings ||
    subsectionLabels.length >= 3
  );
}

function createWrapperDiv() {
  const wrapperDiv = document.createElement("div");
  wrapperDiv.id = "image-wrapper";
  wrapperDiv.style.textAlign = "center";
  wrapperDiv.style.padding = "5px 0";
  return wrapperDiv;
}

function createImageElement(wrapperDiv, imageUrl, vocab, exactSearch) {
  const searchVocab = exactSearch ? `「${vocab}」` : vocab;
  const example = state.examples[state.currentExampleIndex] || {};
  const deck_name = example.deck_name || null;

  let file_name = imageUrl.substring(imageUrl.lastIndexOf("/") + 1);
  file_name = file_name.replace(/^(Anime_|A_|Z)/, "");

  const titleText = `${searchVocab} #${
    state.currentExampleIndex + 1
  } \n${deck_name} \n${file_name}`;

  return addElement(wrapperDiv, "img", {
    src: imageUrl,
    alt: "Embedded Image",
    title: titleText,
    style: `max-width: ${CONFIG.IMAGE_WIDTH}; margin-top: 10px; cursor: pointer;`,
  });
}
// #endregion

// region Image and Display Functions
async function renderImageAndPlayAudio(vocab, shouldAutoPlaySound) {
  const example = state.examples[state.currentExampleIndex] || {};
  const imageUrl = example.image_url || null;
  const soundUrl = example.sound_url || null;
  const sentence = example.sentence || null;
  const translation = example.translation || null;
  const deck_name = example.deck_name || null;
  const storedValue = await chromeStorage.get(state.vocab);

  removeExistingContainer();
  if (!shouldRenderContainer()) return;

  const wrapperDiv = createWrapperDiv();
  const textDiv = await createButtonContainer(
    soundUrl,
    vocab,
    state.exactSearch
  );
  wrapperDiv.appendChild(textDiv);

  const createTextElement = (text) => {
    const textElement = document.createElement("div");
    textElement.textContent = text;
    textElement.style.padding = "100px 0";
    textElement.style.whiteSpace = "pre";
    return textElement;
  };

  if (state.apiDataFetched) {
    if (imageUrl) {
      const imageElement = createImageElement(
        wrapperDiv,
        imageUrl,
        vocab,
        state.exactSearch
      );
      if (imageElement) {
        imageElement.addEventListener("click", () => playAudio(soundUrl));
      }
    } else {
      wrapperDiv.appendChild(createTextElement(`NO IMAGE\n(${deck_name})`));
    }
    sentence
      ? appendSentenceAndTranslation(wrapperDiv, sentence, translation)
      : appendNoneText(wrapperDiv);
  } else if (state.error) {
    wrapperDiv.appendChild(
      createTextElement(
        "ERROR\nNO EXAMPLES FOUND\n\nRARE WORD OR\nIMMERSIONKIT API IS TEMPORARILY DOWN"
      )
    );
  } else {
    wrapperDiv.appendChild(createTextElement("LOADING"));
  }

  const navigationDiv = createNavigationDiv();
  const leftArrow = createLeftArrow(vocab, shouldAutoPlaySound);
  const rightArrow = createRightArrow(vocab, shouldAutoPlaySound);
  const containerDiv = createContainerDiv(
    leftArrow,
    wrapperDiv,
    rightArrow,
    navigationDiv
  );
  appendContainer(containerDiv);

  if (CONFIG.AUTO_PLAY_SOUND && shouldAutoPlaySound) {
    playAudio(soundUrl);
  }
}

function preloadImages() {
  const preloadDiv = addElement(document.body, "div", {
    style: { display: "none" },
  });
  const startIndex = Math.max(
    0,
    state.currentExampleIndex - CONFIG.NUMBER_OF_PRELOADS
  );
  const endIndex = Math.min(
    state.examples.length - 1,
    state.currentExampleIndex + CONFIG.NUMBER_OF_PRELOADS
  );

  for (let i = startIndex; i <= endIndex; i++) {
    if (!state.preloadedIndices.has(i) && state.examples[i].image_url) {
      addElement(preloadDiv, "img", { src: state.examples[i].image_url });
      state.preloadedIndices.add(i);
    }
  }
}

function highlightVocab(sentence, vocab) {
  if (!CONFIG.COLORED_SENTENCE_TEXT) return sentence;

  const regex = new RegExp(`(${vocab})`, "g");
  return sentence.replace(
    regex,
    '<span style="color: var(--outline-input-color);">$1</span>'
  );
}

function appendSentenceAndTranslation(wrapperDiv, sentence, translation) {
  const sentenceText = document.createElement("div");
  sentenceText.innerHTML = highlightVocab(sentence, state.vocab);
  sentenceText.style.marginTop = "10px";
  sentenceText.style.fontSize = CONFIG.SENTENCE_FONT_SIZE;
  sentenceText.style.color = "lightgray";
  sentenceText.style.maxWidth = CONFIG.IMAGE_WIDTH;
  sentenceText.style.whiteSpace = "pre-wrap";
  wrapperDiv.appendChild(sentenceText);

  if (CONFIG.ENABLE_EXAMPLE_TRANSLATION && translation) {
    const translationText = document.createElement("div");
    translationText.innerHTML = replaceSpecialCharacters(translation);
    translationText.style.marginTop = "5px";
    translationText.style.fontSize = CONFIG.TRANSLATION_FONT_SIZE;
    translationText.style.color = "var(--subsection-label-color)";
    translationText.style.maxWidth = CONFIG.IMAGE_WIDTH;
    translationText.style.whiteSpace = "pre-wrap";
    wrapperDiv.appendChild(translationText);
  }
}

function appendNoneText(wrapperDiv) {
  const noneText = document.createElement("div");
  noneText.textContent = "None";
  noneText.style.marginTop = "10px";
  noneText.style.fontSize = "85%";
  noneText.style.color = "var(--subsection-label-color)";
  wrapperDiv.appendChild(noneText);
}

function replaceSpecialCharacters(text) {
  return text
    .replace(/<br>/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/\n/g, "<br>");
}
// #endregion

// #region Navigation Components
function createNavigationDiv() {
  const navigationDiv = document.createElement("div");
  navigationDiv.id = "immersion-kit-embed";
  navigationDiv.style.display = "flex";
  navigationDiv.style.justifyContent = "center";
  navigationDiv.style.alignItems = "center";
  navigationDiv.style.maxWidth = CONFIG.IMAGE_WIDTH;
  navigationDiv.style.margin = "0 auto";
  return navigationDiv;
}

function createLeftArrow(vocab, shouldAutoPlaySound) {
  const leftArrow = document.createElement("button");
  leftArrow.textContent = "🡨"; // Changed from "<" to "🡨"
  leftArrow.style.marginRight = "10px";
  leftArrow.style.width = CONFIG.ARROW_WIDTH;
  leftArrow.style.height = CONFIG.ARROW_HEIGHT;
  leftArrow.style.lineHeight = "25px";
  leftArrow.style.textAlign = "center";
  leftArrow.style.display = "flex";
  leftArrow.style.justifyContent = "center";
  leftArrow.style.alignItems = "center";
  leftArrow.style.padding = "0";
  leftArrow.style.fontSize = "14px";
  leftArrow.disabled = state.currentExampleIndex === 0;

  leftArrow.addEventListener("click", () => {
    if (state.currentExampleIndex > 0) {
      state.currentExampleIndex--;
      state.currentlyPlayingAudio = false;
      renderImageAndPlayAudio(vocab, shouldAutoPlaySound);
      preloadImages();
    }
  });

  return leftArrow;
}

function createRightArrow(vocab, shouldAutoPlaySound) {
  const rightArrow = document.createElement("button");
  rightArrow.textContent = "🡪"; // Changed from ">" to "🡪"
  rightArrow.style.marginLeft = "10px";
  rightArrow.style.width = CONFIG.ARROW_WIDTH;
  rightArrow.style.height = CONFIG.ARROW_HEIGHT;
  rightArrow.style.lineHeight = "25px";
  rightArrow.style.textAlign = "center";
  rightArrow.style.display = "flex";
  rightArrow.style.justifyContent = "center";
  rightArrow.style.alignItems = "center";
  rightArrow.style.padding = "0";
  rightArrow.style.fontSize = "14px";
  rightArrow.disabled = state.currentExampleIndex >= state.examples.length - 1;

  rightArrow.addEventListener("click", () => {
    if (state.currentExampleIndex < state.examples.length - 1) {
      state.currentExampleIndex++;
      state.currentlyPlayingAudio = false;
      renderImageAndPlayAudio(vocab, shouldAutoPlaySound);
      preloadImages();
    }
  });

  return rightArrow;
}

function createContainerDiv(leftArrow, wrapperDiv, rightArrow, navigationDiv) {
  const containerDiv = document.createElement("div");
  containerDiv.id = "immersion-kit-container";
  containerDiv.style.display = "flex";
  containerDiv.style.alignItems = "center";
  containerDiv.style.justifyContent = "center";
  containerDiv.style.flexDirection = "column";

  const arrowWrapperDiv = document.createElement("div");
  arrowWrapperDiv.style.display = "flex";
  arrowWrapperDiv.style.alignItems = "center";
  arrowWrapperDiv.style.justifyContent = "center";

  arrowWrapperDiv.append(leftArrow, wrapperDiv, rightArrow);
  containerDiv.append(arrowWrapperDiv, navigationDiv);

  return containerDiv;
}

async function createButtonContainer(soundUrl, vocab, exact) {
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "button-container";
  buttonContainer.style.display = "flex";
  buttonContainer.style.justifyContent = "space-between";
  buttonContainer.style.alignItems = "center";
  buttonContainer.style.marginBottom = "5px";
  buttonContainer.style.lineHeight = "1.4rem";

  const menuButton = createMenuButton();
  const textButton = createTextButton(vocab, exact);
  const speakerButton = await createSpeakerButton(soundUrl);
  const starButton = await createStarButton();
  const quoteButton = createQuoteButton();

  const centeredButtonsWrapper = document.createElement("div");
  centeredButtonsWrapper.style.display = "flex";
  centeredButtonsWrapper.style.justifyContent = "center";
  centeredButtonsWrapper.style.flex = "1";

  centeredButtonsWrapper.append(
    textButton,
    speakerButton,
    starButton,
    quoteButton
  );
  buttonContainer.append(centeredButtonsWrapper, menuButton);

  return buttonContainer;
}

function createTextButton(vocab, exact) {
  const textButton = document.createElement("a");
  textButton.textContent = "Immersion Kit";
  textButton.style.color = "var(--subsection-label-color)";
  textButton.style.fontSize = "85%";
  textButton.style.marginRight = "0.5rem";
  textButton.style.verticalAlign = "middle";
  textButton.href = `https://www.immersionkit.com/dictionary?keyword=${encodeURIComponent(
    vocab
  )}${exact ? "&exact=true" : ""}`;
  textButton.target = "_blank";
  return textButton;
}

function appendContainer(containerDiv) {
  const resultVocabularySection = document.querySelector(".result.vocabulary");
  const hboxWrapSection = document.querySelector(".hbox.wrap");
  const subsectionMeanings = document.querySelector(".subsection-meanings");
  const subsectionComposedOfKanji = document.querySelector(
    ".subsection-composed-of-kanji"
  );
  const subsectionPitchAccent = document.querySelector(
    ".subsection-pitch-accent"
  );
  const subsectionLabels = document.querySelectorAll("h6.subsection-label");
  const vboxGap = document.querySelector(".vbox.gap");

  if (CONFIG.WIDE_MODE && subsectionMeanings) {
    appendWideMode(
      containerDiv,
      subsectionMeanings,
      subsectionComposedOfKanji,
      subsectionPitchAccent,
      vboxGap
    );
  } else {
    appendNormalMode(
      containerDiv,
      subsectionMeanings,
      resultVocabularySection,
      hboxWrapSection,
      subsectionLabels
    );
  }
}

function appendWideMode(
  containerDiv,
  subsectionMeanings,
  subsectionComposedOfKanji,
  subsectionPitchAccent,
  vboxGap
) {
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "flex-start";

  const originalContentWrapper = document.createElement("div");
  originalContentWrapper.style.flex = "1";
  originalContentWrapper.appendChild(subsectionMeanings);

  if (subsectionComposedOfKanji) {
    const newline1 = document.createElement("br");
    originalContentWrapper.appendChild(newline1);
    originalContentWrapper.appendChild(subsectionComposedOfKanji);
  }
  if (subsectionPitchAccent) {
    const newline2 = document.createElement("br");
    originalContentWrapper.appendChild(newline2);
    originalContentWrapper.appendChild(subsectionPitchAccent);
  }

  wrapper.appendChild(originalContentWrapper);
  wrapper.appendChild(containerDiv);

  if (vboxGap) {
    const existingDynamicDiv = vboxGap.querySelector("#dynamic-content");
    if (existingDynamicDiv) {
      existingDynamicDiv.remove();
    }

    const dynamicDiv = document.createElement("div");
    dynamicDiv.id = "dynamic-content";
    dynamicDiv.appendChild(wrapper);

    if (window.location.href.includes("vocabulary")) {
      vboxGap.insertBefore(dynamicDiv, vboxGap.children[1]);
    } else {
      vboxGap.insertBefore(dynamicDiv, vboxGap.firstChild);
    }
  }
}

function appendNormalMode(
  containerDiv,
  subsectionMeanings,
  resultVocabularySection,
  hboxWrapSection,
  subsectionLabels
) {
  if (state.embedAboveSubsectionMeanings && subsectionMeanings) {
    subsectionMeanings.parentNode.insertBefore(
      containerDiv,
      subsectionMeanings
    );
  } else if (resultVocabularySection) {
    resultVocabularySection.parentNode.insertBefore(
      containerDiv,
      resultVocabularySection
    );
  } else if (hboxWrapSection) {
    hboxWrapSection.parentNode.insertBefore(containerDiv, hboxWrapSection);
  } else if (subsectionLabels.length >= 4) {
    subsectionLabels[3].parentNode.insertBefore(
      containerDiv,
      subsectionLabels[3]
    );
  }
}
// #endregion

// #region Main Functions
async function onPageLoad() {
  state.embedAboveSubsectionMeanings = false;

  const url = window.location.href;
  const machineTranslationFrame = document.getElementById(
    "machine-translation-frame"
  );

  if (!machineTranslationFrame) {
    embedImageAndPlayAudio();
    setPageWidth();

    if (url.includes("/vocabulary/")) {
      state.vocab = parseVocabFromVocabulary();
    } else if (url.includes("/search?q=")) {
      state.vocab = parseVocabFromSearch();
    } else if (url.includes("c=")) {
      state.vocab = parseVocabFromAnswer();
    } else if (url.includes("/kanji/")) {
      state.vocab = parseVocabFromKanji();
    } else {
      state.vocab = parseVocabFromReview();
    }
  } else {
    console.log(
      "Machine translation frame detected, skipping vocabulary parsing."
    );
    return;
  }

  const storedData = await getStoredData(state.vocab);

  if (storedData) {
    // Create a favorite example object with just the essential properties
    const favoriteExample = {
      image_url: storedData.image_url,
      sound_url: storedData.sound_url,
      sentence: storedData.sentence,
    };

    try {
      await getImmersionKitData(state.vocab, state.exactSearch);
      state.examples = [
        favoriteExample,
        ...state.examples.filter(
          (ex) => ex.image_url !== favoriteExample.image_url
        ),
      ];
      state.currentExampleIndex = 0;
      preloadImages();
      if (!/https:\/\/jpdb\.io\/review(#a)?$/.test(url)) {
        embedImageAndPlayAudio();
      }
    } catch (error) {
      console.error(error);
      state.examples = [favoriteExample];
      state.currentExampleIndex = 0;
      state.apiDataFetched = true;
      embedImageAndPlayAudio();
    }
  } else {
    // No favorite exists, proceed with normal search
    if (state.vocab && !state.apiDataFetched) {
      try {
        await getImmersionKitData(state.vocab, state.exactSearch);
        preloadImages();
        if (!/https:\/\/jpdb\.io\/review(#a)?$/.test(url)) {
          embedImageAndPlayAudio();
        }
      } catch (error) {
        console.error(error);
      }
    }
  }
}

function embedImageAndPlayAudio() {
  const existingNavigationDiv = document.getElementById("immersion-kit-embed");
  if (existingNavigationDiv) existingNavigationDiv.remove();

  const reviewUrlPattern = /https:\/\/jpdb\.io\/review(#a)?$/;
  renderImageAndPlayAudio(
    state.vocab,
    !reviewUrlPattern.test(window.location.href)
  );
  preloadImages();
}

function setPageWidth() {
  document.body.style.maxWidth = CONFIG.PAGE_WIDTH;
}

function setVocabSize() {
  const style = document.createElement("style");
  style.type = "text/css";
  style.innerHTML = `
        .answer-box > .plain {
            font-size: ${CONFIG.VOCAB_SIZE} !important;
            padding-bottom: 0.1rem !important;
        }
    `;
  document.head.appendChild(style);
}

async function loadConfig() {
  const configs = await chromeStorage.getAll();
  for (const key in configs) {
    if (!key.startsWith("CONFIG.")) continue;

    const configKey = key.substring("CONFIG.".length);
    if (!CONFIG.hasOwnProperty(configKey)) continue;

    const savedValue = configs[key];
    if (savedValue === null || savedValue === undefined) continue;

    // Handle different types appropriately
    switch (typeof CONFIG[configKey]) {
      case "boolean":
        CONFIG[configKey] = savedValue === true || savedValue === "true";
        break;
      case "number":
        CONFIG[configKey] = Number(savedValue);
        break;
      case "string":
        CONFIG[configKey] = String(savedValue);
        break;
    }
  }
}

// URL Change Observer
const observer = new MutationObserver(() => {
  if (window.location.href !== observer.lastUrl) {
    observer.lastUrl = window.location.href;
    onPageLoad();
  }
});

async function loadVocabContent() {
  try {
    // Get the URL for the CSV file
    const url = chrome.runtime.getURL("sorted-vocab.csv");
    console.log("Attempting to load vocab from:", url);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load vocab file: ${response.status}`);
    }

    const text = await response.text();
    console.log("Successfully loaded vocab file, length:", text.length);
    state.vocabContent = text;
  } catch (error) {
    console.error("Error loading vocab content:", error);
    state.vocabContent = null;
  }
}

// Initialize Extension
async function initializeExtension() {
  await loadConfig();
  await loadVocabContent();
  setPageWidth();
  setVocabSize();

  observer.lastUrl = window.location.href;
  observer.observe(document, { subtree: true, childList: true });

  window.addEventListener("load", onPageLoad);
  window.addEventListener("popstate", onPageLoad);
  window.addEventListener("hashchange", onPageLoad);
}

// Start the extension
initializeExtension();
//#endregion

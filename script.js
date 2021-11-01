"use strict";
// Storing variables which will be in use in this script
const modalWeek = document.querySelector(".week"),
  modalGuess = document.querySelector(".guess"),
  overlay = document.querySelector(".overlay"),
  closeButtonWeek = document.querySelector(".close-button-week"),
  closeButtonGuess = document.querySelector(".close-button-guess"),
  closeButtonDice = document.querySelector(".close-button-dice"),
  modalButtonWeek = document.querySelector(".show-modal-week"),
  modalButtonGuess = document.querySelector(".show-modal-guess"),
  modalButtonDice = document.querySelector(".show-modal-dice"),
  pressedKey = "Escape",
  // Adding a function for to close multiple ways with a click
  eLClick = function (functions, keywords, elements) {
    for (let i = 2; i < arguments.length; i++) {
      arguments[i].addEventListener("click", functions);
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === keywords && !modalWeek.classList.contains("hidden")) {
        closeModalWeek();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === keywords && !modalGuess.classList.contains("hidden")) {
        closeModalGuess();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === keywords && !modalDice.classList.contains("hidden")) {
        closeModalDice();
      }
    });
  },
  // Adding a function for to show hidden elements
  openModalWeek = function () {
    modalWeek.classList.remove("hidden");
    overlay.classList.remove("hidden");
  },
  // Adding a function for to show hidden elements
  openModalGuess = function () {
    modalGuess.classList.remove("hidden");
    overlay.classList.remove("hidden");
  },
  // Adding a function for to show hidden elements
  openModalDice = function () {
    modalDice.classList.remove("hidden");
    overlay.classList.remove("hidden");
  },
  // Adding a function for to hide elements
  closeModalWeek = function () {
    modalWeek.classList.add("hidden");
    overlay.classList.add("hidden");
  },
  // Adding a function for to hide elements
  closeModalGuess = function () {
    modalGuess.classList.add("hidden");
    overlay.classList.add("hidden");
  },
  // Adding a function for to hide elements
  closeModalDice = function () {
    modalDice.classList.add("hidden");
    overlay.classList.add("hidden");
  };

// Listening if button is clicked and showing according to that

eLClick(openModalWeek, "", modalButtonWeek);
eLClick(openModalGuess, "", modalButtonGuess);
eLClick(openModalGuess, "", modalButtonDice);

eLClick(closeModalWeek, pressedKey, closeButtonWeek, overlay);
eLClick(closeModalGuess, pressedKey, closeButtonGuess, overlay);
eLClick(closeModalGuess, pressedKey, closeButtonDice, overlay);

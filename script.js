"use strict";
// Storing variables which will be in use in this script
const modalWeek = document.querySelector(".week"),
  modalGuess = document.querySelector(".guess"),
  modalDice = document.querySelector(".dice"),
  modalColor = document.querySelector(".color"),
  overlay = document.querySelector(".overlay"),
  closeButtonWeek = document.querySelector(".close-button-week"),
  closeButtonGuess = document.querySelector(".close-button-guess"),
  closeButtonDice = document.querySelector(".close-button-dice"),
  closeButtonColor = document.querySelector(".close-button-color"),
  modalButtonWeek = document.querySelector(".show-modal-week"),
  modalButtonGuess = document.querySelector(".show-modal-guess"),
  modalButtonDice = document.querySelector(".show-modal-dice"),
  modalButtonColor = document.querySelector(".show-modal-color"),
  pressedKey = "Escape",
  // Adding a function for to close multiple ways with a click
  eLClick = function (functions, keywords, elements) {
    for (let i = 2; i < arguments.length; i++) {
      arguments[i].addEventListener("click", functions);
    }
const modals = document.querySelectorAll('.modal');
const showButtons = document.querySelectorAll('.show-modal-week, .show-modal-guess, .show-modal-dice, .show-modal-color');
const closeButtons = document.querySelectorAll('.close-modal');
const overlay = document.querySelector('.overlay');

    document.addEventListener("keydown", function (e) {
      if (e.key === keywords && !modalWeek.classList.contains("hidden")) {
        closeModalWeek();
      }
showButtons.forEach((button, index) => {
    button.addEventListener('click', () => {
        modals[index].classList.remove('hidden');
        overlay.classList.remove('hidden');
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
    document.addEventListener("keydown", function (e) {
      if (e.key === keywords && !modalDice.classList.contains("hidden")) {
        closeModalColor();
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
  // Adding a function for to show hidden elements
  openModalColor = function () {
    modalColor.classList.remove("hidden");
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
  },
  // Adding a function for to hide elements
  closeModalColor = function () {
    modalColor.classList.add("hidden");
    overlay.classList.add("hidden");
  };
});

// Listening if button is clicked and showing according to that

eLClick(openModalWeek, "", modalButtonWeek);
eLClick(openModalGuess, "", modalButtonGuess);
eLClick(openModalDice, "", modalButtonDice);
eLClick(openModalColor, "", modalButtonColor);
closeButtons.forEach((button, index) => {
    button.addEventListener('click', () => {
        modals[index].classList.add('hidden');
        overlay.classList.add('hidden');
    });
});

eLClick(closeModalWeek, pressedKey, closeButtonWeek, overlay);
eLClick(closeModalGuess, pressedKey, closeButtonGuess, overlay);
eLClick(closeModalDice, pressedKey, closeButtonDice, overlay);
eLClick(closeModalColor, pressedKey, closeButtonColor, overlay);
overlay.addEventListener('click', () => {
    modals.forEach(modal => modal.classList.add('hidden'));
    overlay.classList.add('hidden');
});
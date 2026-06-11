"use strict";

// =====================================================================
// The whole page is driven by "tags" (data-... attributes in the HTML).
// Each block below is generic: it loops over many buttons, so you almost
// never need to touch this file — you add buttons/popups in index.html.
// =====================================================================

// ===== 1) LEFT PANEL: show the view whose tag matches the clicked button =====
// A button has  data-view="home"  -> it shows the section with class "view-home".
const navBtns = document.querySelectorAll(".nav-btn");
const views = document.querySelectorAll(".view");

navBtns.forEach((btn) =>
  btn.addEventListener("click", () => {
    views.forEach((v) => v.classList.add("hidden")); // hide every view
    document.querySelector(".view-" + btn.dataset.view).classList.remove("hidden"); // show the matching one
    navBtns.forEach((b) => b.classList.remove("active")); // un-highlight every button
    btn.classList.add("active"); // highlight the one we clicked
  })
);

// ===== 2) COLLAPSE / EXPAND the panel =====
// We just add or remove the class "collapsed"; CSS does the sliding and flips the arrow.
const sidebar = document.querySelector(".sidebar");
document
  .querySelector(".sidebar-toggle")
  .addEventListener("click", () => sidebar.classList.toggle("collapsed"));

// ===== 3) POPUPS: one block handles every popup, matched by its data-modal tag =====
// A button has  data-modal="week"  -> it opens the .modal with  data-modal="week".
const overlay = document.querySelector(".overlay");

// Hide all popups + the dark background. (Only one is ever open, so "close all" is enough.)
const closeAll = () => {
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
  overlay.classList.add("hidden");
};

// Open: find the popup whose tag matches the clicked button.
document.querySelectorAll(".open-modal").forEach((btn) =>
  btn.addEventListener("click", () => {
    document
      .querySelector('.modal[data-modal="' + btn.dataset.modal + '"]')
      .classList.remove("hidden");
    overlay.classList.remove("hidden");
  })
);

// Close: the × button, clicking the dark background, or pressing Escape.
document.querySelectorAll(".close-modal").forEach((btn) => btn.addEventListener("click", closeAll));
overlay.addEventListener("click", closeAll);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAll();
});

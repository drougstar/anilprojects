const showButtons = document.querySelectorAll('.show-modal-week, .show-modal-guess, .show-modal-dice, .show-modal-color');
const modals = document.querySelectorAll('.modal');
const closeButtons = document.querySelectorAll('.close-modal');
const overlay = document.querySelector('.overlay');

showButtons.forEach((button, index) => {
    button.addEventListener('click', () => {
        modals[index].classList.remove('hidden');
        overlay.classList.remove('hidden');
    });
});

closeButtons.forEach(button => {
    button.addEventListener('click', () => {
        button.closest('.modal').classList.add('hidden');
        overlay.classList.add('hidden');
    });
});

overlay.addEventListener('click', () => {
    modals.forEach(modal => modal.classList.add('hidden'));
    overlay.classList.add('hidden');
});

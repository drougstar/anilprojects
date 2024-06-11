document.querySelectorAll('.show-modal').forEach(button => {
    button.addEventListener('click', () => {
        const modalId = button.getAttribute('data-modal') + 'Modal';
        const modal = document.getElementById(modalId);
        if (modal) {
            $(modal).modal('show');
        }
    });
});

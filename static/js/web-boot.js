// BookBoom web version: everything runs in this browser (no server). Classic script, loaded first.
window.KETABYAR_LOCAL = true;
// Opened straight from a folder (file://): browsers don't allow background workers there,
// so pdf.js runs in the page instead. Online and when installed it uses its fast worker.
if (location.protocol === 'file:') document.write('<script src="static/vendor/pdfjs/pdf.worker.bundle.js"><\/script>');

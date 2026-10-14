// Browser code, kept in its own file: it is sent to the page, never run on the server.
//
// LP-1, LP-3: the only script on the landing page. It runs the key form and nothing else.
// Plain ES5 with no template literals, so it can sit in an inline script that the CSP allows
// by hash.

export const KEY_FORM_SCRIPT = `(function () {
  var form = document.getElementById("key-form");
  if (!form || typeof fetch !== "function") return;
  var email = document.getElementById("email");
  var submit = document.getElementById("key-submit");
  var status = document.getElementById("key-status");
  var result = document.getElementById("key-result");
  var keyValue = document.getElementById("key-value");
  var copy = document.getElementById("key-copy");
  var failed = "Something went wrong. Try again later.";
  function clear() {
    status.textContent = "";
    result.hidden = true;
  }
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clear();
    submit.disabled = true;
    fetch("/v1/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.value })
    })
      .then(function (res) {
        return res.json().then(
          function (body) { return { status: res.status, body: body }; },
          function () { return { status: res.status, body: null }; }
        );
      })
      .then(
        function (r) {
          if (r.status === 201 && r.body && r.body.api_key) {
            keyValue.textContent = r.body.api_key;
            result.hidden = false;
            email.value = "";
            return;
          }
          submit.disabled = false;
          if (r.status === 429) {
            status.textContent = "Too many attempts. Try again later.";
          } else if (r.status === 400 && r.body && r.body.error) {
            status.textContent = r.body.error.message;
          } else {
            status.textContent = failed;
          }
        },
        function () {
          submit.disabled = false;
          status.textContent = failed;
        }
      );
  });
  copy.addEventListener("click", function () {
    var manual = "Could not copy. Select the key and copy it by hand.";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(keyValue.textContent).then(
        function () { copy.textContent = "Copied"; },
        function () { status.textContent = manual; }
      );
    } else {
      status.textContent = manual;
    }
  });
  form.hidden = false;
})();`;

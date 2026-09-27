// The gate's pages, enhanced. Everything here is optional: with JavaScript off
// the forms post as plain HTML and the server renders the next step.
//
// Loaded blocking in <head> so the stored theme applies before first paint.
(function () {
  "use strict";

  // Follow the theme chosen in the app (same storage key), so signing in does
  // not flash the other palette. `system` leaves prefers-color-scheme in charge.
  try {
    var theme = localStorage.getItem("workbench.theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // Storage blocked: follow the system.
  }

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("login-form");
    if (!form) return;
    var message = document.getElementById("login-message");
    var codeField = document.getElementById("code-field");
    var code = document.getElementById("code");
    var password = document.getElementById("password");
    var submit = form.querySelector("button[type=submit]");

    function show(text, tone) {
      message.textContent = text;
      message.className = "gate-msg is-" + tone;
      message.hidden = false;
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var data = new FormData(form);
      var body = {
        username: String(data.get("username") || ""),
        password: String(data.get("password") || ""),
        remember: data.get("remember") === "1",
        next: String(data.get("next") || "/"),
      };
      var typed = String(data.get("code") || "").trim();
      if (!codeField.hidden && typed) body.code = typed;
      submit.disabled = true;
      fetch("/_gate/login", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      })
        .then(function (res) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (json) {
              if (res.ok) {
                location.assign(json.next || "/");
                return;
              }
              submit.disabled = false;
              var tone = json.error === "code_required" ? "info" : "error";
              show(json.message || "Sign-in failed. Try again.", tone);
              if (json.error === "code_required" || json.error === "invalid_code") {
                codeField.hidden = false;
                code.value = "";
                code.focus();
              } else if (json.error === "invalid") {
                password.value = "";
                password.focus();
              }
            });
        })
        .catch(function () {
          submit.disabled = false;
          show("Could not reach the box. Check your connection and try again.", "error");
        });
    });
  });
})();

// Placeholder for the Connect screen (task 7-02): proves the bundled page loads inside the Android WebView.
document.getElementById("msg")!.textContent += ` (WebView: ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "unknown"})`;

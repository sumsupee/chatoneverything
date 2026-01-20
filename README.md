# Chat on Everything

**Chat on Everything** is a transparent overlay for Linux (and other platforms) that provides click-through support, global hotkeys, and a mobile companion app for remote control and chat. It's designed to bring a seamless, HUD-like chat experience to your desktop.

## Features

-   **Transparent Overlay**: A sleek, non-intrusive chat window that sits on top of your other windows.
-   **Click-Through Support**: The overlay allows you to click through it to interact with underlying applications when in "passive" mode.
-   **Global Hotkeys**: Toggle the overlay visibility and input mode instantly with `Ctrl+Alt+K` (customizable).
-   **Mobile Companion App**: Connect your phone via QR code to use it as a secondary screen for chat or a remote control.
-   **Remote Control**: Control your computer's mouse, keyboard, and media playback directly from your mobile device using Nut.js.
-   **@Cee AI Agent**: A built-in context-aware AI assistant (powered by OpenAI or Gemini) that can "see" your screen and answer questions about what you're working on.
-   **Moderation & Privacy**: Includes features like slow mode, IP hiding, and chat history management.

## Tech Stack

![Electron](https://img.shields.io/badge/Electron-191970?style=for-the-badge&logo=Electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![WebSockets](https://img.shields.io/badge/WebSockets-black?style=for-the-badge&logo=socket.io&logoColor=white)
![Nut.js](https://img.shields.io/badge/Nut.js-999999?style=for-the-badge&logo=npm&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=for-the-badge&logo=google%20gemini&logoColor=white)

## Gallery

### Desktop Interface

<p align="center">
  <img src="assets/readme/1.png" width="48%" />
  <img src="assets/readme/2.png" width="48%" />
</p>
<p align="center">
  <em>Left: The unobtrusive overlay bar on the desktop. Right: The overlay expanded with an active chat session.</em>
</p>

<p align="center">
  <img src="assets/readme/3.png" width="48%" />
  <img src="assets/readme/4.png" width="48%" />
</p>
<p align="center">
  <em>Left: The comprehensive settings menu. Right: The chat interface showing interactions.</em>
</p>

### Mobile Companion

<p align="center">
  <img src="assets/readme/5.jpeg" width="200" />
  <img src="assets/readme/6.jpeg" width="200" />
  <img src="assets/readme/7.jpeg" width="200" />
</p>
<p align="center">
  <em>The mobile companion app allows for chatting (Left), remote control of mouse/keyboard (Center), and adjusting settings (Right).</em>
</p>

## Installation & Build

### Prerequisites
-   Node.js (v18 or higher recommended)
-   npm (comes with Node.js)

### Running Locally

1.  Clone the repository:
    ```bash
    git clone https://github.com/sumsupee/chatoneverything.git
    cd chatoneverything
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Start the application:
    ```bash
    npm start
    ```

    *Note: On Linux, this runs with `ELECTRON_OZONE_PLATFORM_HINT=x11` and transparency flags enabled.*

### Building for Production

Use the following commands to build the application for your specific platform:

-   **Linux**: `npm run build:linux` (Outputs AppImage and deb)
-   **Windows**: `npm run build:win` (Outputs NSIS installer and portable executable)
-   **macOS**: `npm run build:mac` (Outputs DMG and ZIP)

## Troubleshooting

### macOS: "App is damaged and can't be opened"

If you see this error when trying to run the app on macOS, it is because the app is not notarized by Apple.

**How to Fix:**

1.  Move the app to your **Applications** folder.
2.  Open **Terminal** (Cmd+Space, type "Terminal").
3.  Run the following command to remove the quarantine attribute:

    ```bash
    xattr -cr /Applications/chat-on-everything.app
    ```
    *(Note: If you renamed the app, replace `chat-on-everything.app` with the correct name)*

4.  You should now be able to open the app normally.

## Contributing

Contributions are welcome! Please follow these steps:

1.  Fork the repository.
2.  Create a new branch (`git checkout -b feature/your-feature`).
3.  Commit your changes (`git commit -m 'Add some feature'`).
4.  Run linting to ensure code style:
    ```bash
    npm run lint
    ```
5.  Push to the branch (`git push origin feature/your-feature`).
6.  Open a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

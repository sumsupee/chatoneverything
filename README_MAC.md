# macOS Troubleshooting

## "App is damaged and can't be opened"

If you see this error when trying to run the app on macOS, it is because the app is not notarized by Apple. macOS proactively quarantines applications downloaded from the internet that lack a Developer ID signature.

### How to Fix

1.  Move the app to your **Applications** folder.
2.  Open **Terminal** (Cmd+Space, type "Terminal").
3.  Run the following command to remove the quarantine attribute:

    ```bash
    xattr -cr /Applications/chat-on-everything.app
    ```

    *(Note: If you renamed the app, replace `chat-on-everything.app` with the correct name)*

4.  You should now be able to open the app normally.

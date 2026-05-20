name: Backup to Release

on:
  schedule:
    # 每天运行一次，UTC 时间 02:00（北京时间 10:00）
    - cron: '0 2 * * *'
  workflow_dispatch: # 允许手动触发

permissions:
  contents: write

jobs:
  backup:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Trigger backup on all sites
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Playwright
        run: npm install playwright

      - name: Install Chromium
        run: npx playwright install chromium --with-deps

      - name: Download all backups
        run: node download.js

      - name: Upload to GitHub Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          RELEASE_TAG="backup"
          REPO="${GITHUB_REPOSITORY}"
          
          # 获取或创建 Release
          RELEASE_INFO=$(curl -s \
            -H "Authorization: Bearer ${GITHUB_TOKEN}" \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}" || echo "")
          
          RELEASE_ID=$(echo "$RELEASE_INFO" | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*' || echo "")
          
          if [ -z "$RELEASE_ID" ]; then
            echo "创建新的 Release..."
            CREATE_RESP=$(curl -s -X POST \
              -H "Authorization: Bearer ${GITHUB_TOKEN}" \
              -H "Accept: application/vnd.github+json" \
              -H "Content-Type: application/json" \
              "https://api.github.com/repos/${REPO}/releases" \
              -d "{\"tag_name\":\"${RELEASE_TAG}\",\"target_commitish\":\"${GITHUB_REF_NAME}\",\"name\":\"Backup\",\"body\":\"\",\"draft\":false,\"prerelease\":false}" || echo "")
            RELEASE_ID=$(echo "$CREATE_RESP" | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*' || echo "")
          fi
          
          [ -z "$RELEASE_ID" ] && { echo "无法获取/创建 Release"; exit 1; }
          
          echo "Release ID: $RELEASE_ID"
          
          # 上传所有 zip 文件
          for zipfile in website/*.zip; do
            [ ! -f "$zipfile" ] && continue
            
            filename=$(basename "$zipfile")
            echo "上传: $filename"
            
            # 删除同名旧文件
            ASSETS=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
              -H "Accept: application/vnd.github+json" \
              "https://api.github.com/repos/${REPO}/releases/${RELEASE_ID}/assets" || echo "")
            
            OLD_ID=$(echo "$ASSETS" | grep -B 3 "\"name\": \"$filename\"" | grep '"id"' | grep -o '[0-9]*' | head -1 || echo "")
            
            if [ -n "$OLD_ID" ]; then
              echo "  删除旧文件 (ID: $OLD_ID)..."
              curl -s -X DELETE \
                -H "Authorization: Bearer ${GITHUB_TOKEN}" \
                -H "Accept: application/vnd.github+json" \
                "https://api.github.com/repos/${REPO}/releases/assets/${OLD_ID}" || true
              sleep 1
            fi
            
            # 上传新文件
            UPLOAD_RESP=$(curl -s -X POST \
              --max-time 300 \
              -H "Authorization: Bearer ${GITHUB_TOKEN}" \
              -H "Accept: application/vnd.github+json" \
              -H "Content-Type: application/zip" \
              -T "$zipfile" \
              "https://uploads.github.com/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${filename}" 2>&1 || echo "")
            
            DL_URL=$(echo "$UPLOAD_RESP" | grep -o '"browser_download_url":"[^"]*"' | cut -d'"' -f4 || echo "")
            
            if [ -n "$DL_URL" ]; then
              SIZE=$(stat -c%s "$zipfile" 2>/dev/null || echo 0)
              SIZE_MB=$(echo "scale=2; $SIZE / 1024 / 1024" | bc)
              echo "  上传成功: ${SIZE_MB} MB"
            else
              echo "  上传失败"
            fi
          done
          
          echo ""
          echo "备份完成"

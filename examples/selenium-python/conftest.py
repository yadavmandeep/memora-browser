# Selenium on Memora: the only Memora-specific code is the Remote driver URL.
# Start the server first:  npx memora-browser serve --protocol webdriver
import os

import pytest
from selenium import webdriver

MEMORA_URL = os.environ.get("MEMORA_WEBDRIVER_URL", "http://127.0.0.1:9222")


@pytest.fixture
def driver():
    d = webdriver.Remote(
        command_executor=MEMORA_URL,
        # Selenium requires an options object; Memora accepts any browser's.
        options=webdriver.ChromeOptions(),
    )
    yield d
    d.quit()

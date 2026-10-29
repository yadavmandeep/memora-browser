# Plain Selenium tests: they run unchanged on Chrome and on Memora.
import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

BASE = "https://quotes.toscrape.com"


def test_login(driver):
    driver.get(f"{BASE}/login")
    driver.find_element(By.ID, "username").send_keys("panda")
    driver.find_element(By.ID, "password").send_keys("secret")
    driver.find_element(By.CSS_SELECTOR, "input[type=submit]").click()
    logout = WebDriverWait(driver, 5).until(
        EC.presence_of_element_located((By.LINK_TEXT, "Logout"))
    )
    assert logout.text == "Logout"


@pytest.mark.xfail(reason="/js/ loads jQuery via <script src> and uses document.write, which the native engine does not support yet")
def test_js_rendered_quotes(driver):
    # Quotes on /js/ are injected by JavaScript, not in the HTML source.
    driver.get(f"{BASE}/js/")
    quotes = WebDriverWait(driver, 5).until(
        EC.presence_of_all_elements_located((By.CSS_SELECTOR, ".quote"))
    )
    assert len(quotes) == 10
    assert driver.find_element(By.CSS_SELECTOR, ".quote .author").text == "Albert Einstein"


def test_pagination_and_xpath(driver):
    driver.get(BASE)
    first_page_author = driver.find_element(By.XPATH, "(//small[@class='author'])[1]").text
    driver.find_element(By.PARTIAL_LINK_TEXT, "Next").click()
    assert driver.current_url.rstrip("/").endswith("/page/2")
    assert driver.find_element(By.XPATH, "(//small[@class='author'])[1]").text != first_page_author
    driver.back()
    assert driver.find_element(By.CSS_SELECTOR, ".quote .author").text == first_page_author


def test_tag_link_visible_and_attribute(driver):
    driver.get(BASE)
    tag = driver.find_element(By.CSS_SELECTOR, ".tags a.tag")
    assert tag.is_displayed()
    assert tag.get_attribute("href").startswith(f"{BASE}/tag/")
    tag.click()
    assert "Viewing tag" in driver.find_element(By.TAG_NAME, "h3").text


def test_search_page_and_execute_script(driver):
    driver.get(f"{BASE}/search.aspx")
    assert driver.find_element(By.ID, "author").is_displayed()
    assert driver.execute_script("return document.title") == driver.title

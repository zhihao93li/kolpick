FROM apify/actor-python:3.13
COPY requirements.txt actor-requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r actor-requirements.txt
COPY . ./
CMD ["python", "-m", "kolpick.actor_main"]

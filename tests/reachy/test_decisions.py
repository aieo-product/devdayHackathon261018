import json

import httpx
import pytest

from reachy_focus.config import Settings
from reachy_focus.decisions import DecisionError, DecisionsEvaluator, parse_decision


def payload(observable=1, phone=0.95):
    return {
        "answers": [
            {"type": "predicate", "name": "observable", "probability": observable},
            {"type": "predicate", "name": "phone_in_use", "probability": phone},
        ]
    }


def test_decisions_wire_contract():
    def handle(request):
        assert str(request.url) == "https://api.openai.com/v1/decisions"
        assert request.headers["authorization"] == "Bearer test-secret"
        body = json.loads(request.content)
        assert body["model"] == "gpt-6-luna"
        assert (
            body["input"][0]["content"][1]["image_url"]
            == "data:image/jpeg;base64,anBlZw=="
        )
        assert {q["name"] for q in body["questions"]} == {"observable", "phone_in_use"}
        return httpx.Response(200, json=payload())

    evaluator = DecisionsEvaluator(httpx.MockTransport(handle))
    assert (
        evaluator.evaluate(b"jpeg", Settings(api_key="test-secret")).phone_probability
        == 0.95
    )


@pytest.mark.parametrize("p", [None, True, -1, 1.1, float("nan"), "0.9"])
def test_invalid_probability_is_not_silently_zero(p):
    with pytest.raises(DecisionError, match="invalid_response"):
        parse_decision(payload(phone=p))


def test_missing_and_refusal_and_unobservable():
    with pytest.raises(DecisionError):
        parse_decision({"answers": []})
    assert not parse_decision(
        {"answers": [{"type": "refusal", "name": "phone_in_use"}]}
    ).observable
    assert parse_decision(payload(observable=0.3)).phone_probability is None


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "authentication"),
        (403, "permission"),
        (429, "rate_limited"),
        (500, "api_error"),
    ],
)
def test_error_body_never_leaks(status, code):
    evaluator = DecisionsEvaluator(
        httpx.MockTransport(
            lambda _: httpx.Response(status, text="PRIVATE KEY AND IMAGE")
        )
    )
    with pytest.raises(DecisionError) as err:
        evaluator.evaluate(b"private", Settings(api_key="test"))
    assert str(err.value) == code

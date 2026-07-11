import XCTest
@testable import Vital

@MainActor
final class ProfileViewModelTests: XCTestCase {
    func testProfileResponseDecodesPersonalDetailsAndNullableAverageHrv() throws {
        let data = Data(
            """
            {
              "name": "Taylor",
              "integrations": [],
              "stats": {
                "loggedDays": 12,
                "mealsLogged": 24,
                "avgHrv": null,
                "workouts": 4
              },
              "profile": {
                "age": 34,
                "biologicalSex": "Female",
                "heightCm": 167.6,
                "weightKg": 62.5
              }
            }
            """.utf8
        )

        let response = try JSONDecoder().decode(ProfileResponse.self, from: data)

        XCTAssertEqual(response.profile.age, 34)
        XCTAssertEqual(response.profile.biologicalSex, "Female")
        XCTAssertEqual(response.profile.heightCm, 167.6)
        XCTAssertEqual(response.profile.weightKg, 62.5)
        XCTAssertNil(response.stats.avgHrv)
    }

    func testProfileCellsExposeExactlyThePersonalDetailsInMetricUnits() {
        let cells = ProfileViewModel.profileCells(
            from: ProfileDetails(age: 34, biologicalSex: "Female", heightCm: 167.6, weightKg: 62.5),
            units: .metric
        )

        XCTAssertEqual(cells.map(\.label), ["Age", "Height", "Current weight", "Biological sex"])
        XCTAssertEqual(cells.map(\.value), ["34", "168 cm", "62.5 kg", "Female"])
    }

    func testActivityCellsExposeExactlyTheActivityStats() {
        let cells = ProfileViewModel.activityCells(
            from: ProfileStats(loggedDays: 12, mealsLogged: 24, avgHrv: 61.5, workouts: 4)
        )

        XCTAssertEqual(cells.map(\.label), ["Logged days", "Meals logged", "Avg HRV", "Workouts"])
        XCTAssertEqual(cells.map(\.value), ["12", "24", "62 ms", "4"])
    }

    func testProfileCellsFormatMeasurementsInUSUnitsWhenExplicitlyRequested() {
        let cells = ProfileViewModel.profileCells(
            from: ProfileDetails(age: 29, biologicalSex: "Male", heightCm: 175.3, weightKg: 70),
            units: .us
        )

        XCTAssertEqual(cells.map(\.value), ["29", "5' 9\"", "154 lb", "Male"])
    }

    func testProfileUnitSystemMapsMeasurementSystemWithoutLocaleInference() {
        XCTAssertEqual(ProfileUnitSystem.from(measurementSystem: .metric), .metric)
        XCTAssertEqual(ProfileUnitSystem.from(measurementSystem: .us), .us)
    }

    func testProfileCellsUsePlaceholdersForMissingPersonalDetails() {
        let cells = ProfileViewModel.profileCells(
            from: ProfileDetails(age: nil, biologicalSex: nil, heightCm: nil, weightKg: nil),
            units: .metric
        )

        XCTAssertEqual(cells.map(\.value), ["--", "--", "--", "--"])
    }

    func testActivityCellsUsePlaceholderForMissingHRV() {
        let cells = ProfileViewModel.activityCells(
            from: ProfileStats(loggedDays: 0, mealsLogged: 0, avgHrv: nil, workouts: 0)
        )

        XCTAssertEqual(cells.map(\.value), ["0", "0", "--", "0"])
    }
}
